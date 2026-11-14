/**
 * Consent Handlers Unit Tests
 *
 * Tests for OAuth2/OIDC consent screen:
 * - GET: Display consent information
 * - POST: Handle approval/denial
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Env } from '@authrim/ar-lib-core/types/env';
import {
  getConsentItemsForScreen,
  processConsentItemDecisions,
  resolveStatementRequirements,
  ssoConsentStatementsForTarget,
  StatementConsentAccountReadError,
} from '@authrim/ar-lib-core';
import { consentGetHandler, consentPostHandler } from '../consent';
import { releasePresentationKey } from '@authrim/ar-lib-core';
import { systemSettingsPlatformDocuments } from '@authrim/ar-lib-core/utils/system-settings-fields';

/** A SETTINGS mock holding an older `system_settings` document's values as platform values. */
function platformSettingsGet(document: Record<string, unknown>) {
  const documents = systemSettingsPlatformDocuments(document);
  return vi.fn(async (key: string) => (key in documents ? JSON.stringify(documents[key]) : null));
}

const mockRedirectWithError = vi.hoisted(() => vi.fn());
const mockResolveClientTrustPolicy = vi.hoisted(() => vi.fn());
const mockResolveAccountDataContextFromHono = vi.hoisted(() => vi.fn());
const mockValidateActingAsRelationship = vi.hoisted(() => vi.fn());
// Events consent.ts publishes without awaiting them. Delivery logs through the real ar-lib-core
// logger, so each test waits for it; a log that lands after the file's last test reaches Vitest
// while the worker is closing and fails the run as an unhandled error.
const unawaitedEvents = vi.hoisted(() => ({ pending: [] as Promise<unknown>[] }));

// What the app would release about the user (the release candidates the screen shows), and the
// app's metadata when a test sets one: unset, the real lookup runs and the release is not asked.
const releaseFixture = vi.hoisted(() => ({
  client: undefined as Record<string, unknown> | undefined,
  candidates: [] as Array<{ name: string; required: boolean }>,
  values: {} as Record<string, unknown>,
}));
vi.mock('../release-candidates', () => ({
  computeReleaseCandidates: vi.fn(async () => ({
    candidates: releaseFixture.candidates,
    values: releaseFixture.values,
  })),
}));

const mockAnswerFormPostAsData = vi.hoisted(() => vi.fn());
vi.mock('../authorize', () => ({
  redirectWithError: mockRedirectWithError,
  answerFormPostAsData: mockAnswerFormPostAsData,
  formPostAnsweredAsData: (c: { req: { header: (name: string) => string | undefined } }) =>
    c.req.header('x-authrim-relay') === 'structured',
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    publishEvent: (...args: Parameters<typeof actual.publishEvent>) => {
      const delivery = actual.publishEvent(...args);
      unawaitedEvents.pending.push(delivery);
      return delivery;
    },
    getClientCached: (...args: Parameters<typeof actual.getClientCached>) =>
      releaseFixture.client
        ? Promise.resolve(releaseFixture.client)
        : actual.getClientCached(...args),
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
    ssoConsentStatementsForTarget: vi.fn(async () => []),
    resolveStatementRequirements: vi.fn(async () => []),
    processConsentItemDecisions: vi.fn(async () => undefined),
    resolveClientTrustPolicy: mockResolveClientTrustPolicy,
    resolveAccountDataContextFromHono: mockResolveAccountDataContextFromHono,
    validateActingAsRelationship: mockValidateActingAsRelationship,
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
    // D1 reports the rows a write changed.
    run: vi
      .fn()
      .mockResolvedValue({ meta: { changes: 1 }, ...(options.runResult ?? { success: true }) }),
  };

  return {
    prepare: vi.fn().mockReturnValue(mockStatement),
    // Each statement of a batch changed one row (the consent write, then its history).
    batch: vi.fn(async (statements: unknown[]) =>
      statements.map(() => ({ success: true, meta: { changes: 1 } }))
    ),
    _mockStatement: mockStatement,
  } as unknown as D1Database & { _mockStatement: typeof mockStatement };
}

// Helper to create mock ChallengeStore DO
function createMockChallengeStore(challengeData?: any) {
  const challenges = new Map<string, any>();

  if (challengeData) {
    const normalizedChallenge =
      challengeData.type === 'consent' && challengeData.metadata?.session_id === undefined
        ? {
            ...challengeData,
            metadata: {
              ...challengeData.metadata,
              session_id: 'g1:apac:3:session_user_123',
            },
          }
        : challengeData;
    challenges.set(challengeData.id, normalizedChallenge);
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
  /** The user's account database, when it differs from the tenant metadata database. */
  accountDb?: D1Database;
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
  const contextStore = new Map<string, unknown>([
    ['tenantId', 'default'],
    [
      'tenantMetadataContext',
      {
        tenantId: 'default',
        coreDb: mockDB,
        route: {
          tenantId: 'default',
          dataRole: 'core',
          bindingRef: 'DB',
          residencyPartition: 'default',
          generation: 1,
        },
      },
    ],
    [
      'accountDataContext',
      {
        tenantId: 'default',
        accountId: 'user-123',
        legacyUserId: 'user-123',
        coreDb: options.accountDb ?? mockDB,
        piiDb: mockDB,
        coreBindingRef: 'DB',
        piiBindingRef: 'DB',
        coreResidencyPartition: 'default',
        piiResidencyPartition: 'default',
        accountRouteGeneration: 1,
        userCacheScope: { tenantId: 'default', accountRouteGeneration: 1 },
        piiCacheMode: 'disabled',
      },
    ],
  ]);

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
        if (normalizedName === 'cookie') {
          return options.headers?.cookie ?? 'authrim_session=g1%3Aapac%3A3%3Asession_user_123';
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
      SESSION_STORE: {
        idFromName: vi.fn().mockReturnValue({ toString: () => 'mock-session-id' }),
        get: vi.fn().mockReturnValue({
          getSessionRpc: vi.fn().mockResolvedValue({
            userId: 'user-123',
            expiresAt: Date.now() + 60_000,
          }),
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
    vi.mocked(ssoConsentStatementsForTarget).mockResolvedValue([]);
    vi.mocked(resolveStatementRequirements).mockResolvedValue([]);
    vi.mocked(processConsentItemDecisions).mockResolvedValue(undefined);
    mockResolveClientTrustPolicy.mockResolvedValue(null);
    mockValidateActingAsRelationship.mockResolvedValue({
      valid: false,
      error: 'No valid acting-as relationship exists',
    });
    mockResolveAccountDataContextFromHono.mockImplementation(async (c, userId: string) => {
      const context = c.get('accountDataContext');
      return { ...context, accountId: userId, legacyUserId: userId };
    });
    mockRedirectWithError.mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: {
          Location: 'https://example.com/callback?response=signed-jarm',
        },
      })
    );
  });

  afterEach(async () => {
    while (unawaitedEvents.pending.length > 0) {
      await Promise.allSettled(unawaitedEvents.pending.splice(0));
    }
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

    it('returns JSON consent data even when the request asks for HTML', async () => {
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

      expect(response.status).toBe(200);
      expect(c.html).not.toHaveBeenCalled();
      await expect(response.json()).resolves.toMatchObject({
        challenge_id: 'unsafe-consent-challenge',
      });
    });

    describe('statement consent items', () => {
      function consentScreenContext() {
        const challengeStore = createMockChallengeStore({
          id: 'consent-items-challenge',
          type: 'consent',
          userId: 'user-123',
          metadata: { client_id: 'test-client', scope: 'openid profile' },
        });
        const mockDB = createMockDB({
          firstResult: {
            client_id: 'test-client',
            client_name: 'Test Application',
            logo_uri: null,
            client_uri: null,
            policy_uri: null,
            tos_uri: null,
            is_trusted: 0,
          },
        });
        const accountDb = createMockDB({});
        const c = createMockContext({
          query: { challenge_id: 'consent-items-challenge' },
          headers: { accept: 'application/json' },
          challengeStore,
          db: mockDB,
          accountDb,
        }) as unknown as Parameters<typeof consentGetHandler>[0];
        return { c, metadataDb: mockDB, accountDb };
      }

      it('reads definitions from the metadata store and records from the account store', async () => {
        const { c, metadataDb, accountDb } = consentScreenContext();

        const response = await consentGetHandler(c);

        expect(response.status).toBe(200);
        const [stores] = vi.mocked(getConsentItemsForScreen).mock.calls[0];
        const prepared = (db: unknown) => (db as { prepare: ReturnType<typeof vi.fn> }).prepare;
        prepared(metadataDb).mockClear();
        prepared(accountDb).mockClear();
        await stores.metadata.query('SELECT 1');
        expect(prepared(metadataDb)).toHaveBeenCalledTimes(1);
        expect(prepared(accountDb)).not.toHaveBeenCalled();
        await stores.account.query('SELECT 1');
        expect(prepared(accountDb)).toHaveBeenCalledTimes(1);
        expect(prepared(metadataDb)).toHaveBeenCalledTimes(1);
      });

      it("asks for the statements the app's sign-in Flow requires at single sign-on", async () => {
        const required = [{ statement_id: 'stmt-terms', required: true }];
        const resolved = [{ statement_id: 'stmt-terms', is_required: true }];
        vi.mocked(ssoConsentStatementsForTarget).mockResolvedValue(required);
        vi.mocked(resolveStatementRequirements).mockResolvedValue(resolved as never);
        const { c } = consentScreenContext();

        const response = await consentGetHandler(c);

        expect(response.status).toBe(200);
        expect(vi.mocked(ssoConsentStatementsForTarget).mock.calls[0].slice(1)).toEqual([
          expect.any(String),
          { type: 'oidc_client', id: 'test-client' },
          // The signed-in person's attributes are read for a condition on them.
          expect.any(Function),
        ]);
        expect(vi.mocked(resolveStatementRequirements).mock.calls[0][2]).toEqual(required);
        // The screen shows what those requirements resolve to, with the user's answers.
        expect(vi.mocked(getConsentItemsForScreen).mock.calls[0][2]).toEqual(resolved);
      });

      it('answers 503 instead of asking again or skipping when the account records cannot be read', async () => {
        vi.mocked(getConsentItemsForScreen).mockRejectedValue(
          new StatementConsentAccountReadError(new Error('account database down'))
        );
        const { c } = consentScreenContext();

        const response = await consentGetHandler(c);

        expect(response.status).toBe(503);
        await expect(response.json()).resolves.toEqual({
          error: 'temporarily_unavailable',
          error_description: 'Consent records are temporarily unavailable',
        });
      });

      it('keeps an unreadable definition non-blocking, as before', async () => {
        vi.mocked(getConsentItemsForScreen).mockRejectedValue(new Error('definitions unavailable'));
        const { c } = consentScreenContext();

        const response = await consentGetHandler(c);

        expect(response.status).toBe(200);
      });
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

    it('derives the trusted badge from Client Trust Policy instead of legacy metadata', async () => {
      const challengeStore = createMockChallengeStore({
        id: 'authoritative-trust-challenge',
        type: 'consent',
        userId: 'user-123',
        metadata: { client_id: 'test-client', scope: 'openid' },
      });
      const db = createMockDB({
        firstResult: {
          client_id: 'test-client',
          client_name: 'Test App',
          is_trusted: 1,
        },
      });

      const withoutPolicy = createMockContext({
        query: { challenge_id: 'authoritative-trust-challenge' },
        challengeStore,
        db,
      });
      await consentGetHandler(withoutPolicy);
      expect(withoutPolicy.json).toHaveBeenCalledWith(
        expect.objectContaining({ client: expect.objectContaining({ is_trusted: false }) })
      );

      mockResolveClientTrustPolicy.mockResolvedValue({
        target_type: 'oidc_client',
        target_id: 'test-client',
        first_party: true,
        trusted: true,
        skip_authorization_consent: false,
      });
      const policyChallengeStore = createMockChallengeStore({
        id: 'policy-trust-challenge',
        type: 'consent',
        userId: 'user-123',
        metadata: { client_id: 'test-client', scope: 'openid' },
      });
      const withPolicy = createMockContext({
        query: { challenge_id: 'policy-trust-challenge' },
        challengeStore: policyChallengeStore,
        db,
      });
      await consentGetHandler(withPolicy);
      expect(withPolicy.json).toHaveBeenCalledWith(
        expect.objectContaining({ client: expect.objectContaining({ is_trusted: true }) })
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
  });

  describe('consentPostHandler', () => {
    it('rejects a session-bound consent challenge when only the bearer challenge is presented', async () => {
      const challengeStore = createMockChallengeStore({
        id: 'session-bound-consent',
        tenantId: 'default',
        type: 'consent',
        userId: 'user-123',
        metadata: {
          client_id: 'client-123',
          redirect_uri: 'https://client.example.com/callback',
          scope: 'openid profile',
          session_id: 'g1:apac:3:session_victim',
        },
      });
      const c = createMockContext({
        method: 'POST',
        body: { challenge_id: 'session-bound-consent', approved: true },
        headers: { cookie: '' },
        challengeStore,
      });

      const response = await consentPostHandler(c);

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toMatchObject({ error: 'access_denied' });
      expect(challengeStore._challenges.has('session-bound-consent')).toBe(true);
      expect(c._mockDB.prepare).not.toHaveBeenCalledWith(
        expect.stringContaining('oauth_client_consents')
      );
    });

    it('rejects legacy consent challenges that have no authenticated session binding', async () => {
      const challengeStore = createMockChallengeStore({
        id: 'legacy-unbound-consent',
        tenantId: 'default',
        type: 'consent',
        userId: 'user-123',
        metadata: {
          client_id: 'client-123',
          redirect_uri: 'https://client.example.com/callback',
          scope: 'openid profile',
          session_id: null,
        },
      });
      const c = createMockContext({
        method: 'POST',
        body: { challenge_id: 'legacy-unbound-consent', approved: true },
        challengeStore,
      });

      const response = await consentPostHandler(c);

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toMatchObject({ error: 'access_denied' });
      expect(challengeStore._challenges.has('legacy-unbound-consent')).toBe(true);
    });
    it('should require challenge_id parameter', async () => {
      const c = createMockContext({
        method: 'POST',
        body: { approved: true },
        headers: { 'content-type': 'application/json' },
      });

      const response = await consentPostHandler(c);

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

    it('answers a form post as data only for the lite relay that asks for it', async () => {
      const store = () =>
        createMockChallengeStore({
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
      mockAnswerFormPostAsData.mockClear();
      await consentPostHandler(
        createMockContext({
          method: 'POST',
          body: { challenge_id: 'consent-challenge-123', approved: false },
          headers: { 'content-type': 'application/json' },
          challengeStore: store(),
        }) as Parameters<typeof consentPostHandler>[0]
      );
      expect(mockAnswerFormPostAsData).not.toHaveBeenCalled();
      await consentPostHandler(
        createMockContext({
          method: 'POST',
          body: { challenge_id: 'consent-challenge-123', approved: false },
          headers: { 'content-type': 'application/json', 'x-authrim-relay': 'structured' },
          challengeStore: store(),
        }) as Parameters<typeof consentPostHandler>[0]
      );
      expect(mockAnswerFormPostAsData).toHaveBeenCalledTimes(1);
    });

    it('denies a form_post request through the form post response when asked for data', async () => {
      mockRedirectWithError.mockClear();
      const c = createMockContext({
        method: 'POST',
        body: { challenge_id: 'consent-challenge-fp', approved: false },
        headers: { 'content-type': 'application/json', 'x-authrim-relay': 'structured' },
        challengeStore: createMockChallengeStore({
          id: 'consent-challenge-fp',
          type: 'consent',
          userId: 'user-123',
          metadata: {
            client_id: 'test-client',
            redirect_uri: 'https://example.com/callback',
            scope: 'openid',
            state: 'test-state',
            response_mode: 'form_post',
          },
        }),
      }) as Parameters<typeof consentPostHandler>[0];
      await consentPostHandler(c);
      expect(mockRedirectWithError).toHaveBeenCalledWith(
        c,
        'https://example.com/callback',
        'access_denied',
        'User denied the consent request',
        'test-state',
        expect.objectContaining({ responseMode: 'form_post', isUserCancellation: true })
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
            get: platformSettingsGet({
              fapi: {
                messageSigning: {
                  enabled: true,
                  requireJarm: true,
                  authorizationSigningAlgorithms: ['ES256'],
                },
              },
            }),
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

    describe('consent withdrawal generation', () => {
      function approvalChallenge() {
        return createMockChallengeStore({
          id: 'consent-challenge-gen',
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
      }

      /** An account database whose consent withdrawal read fails while `readFails()` says so. */
      function accountDb(options: { readFails?: () => boolean; consentWrites?: number } = {}) {
        const mockDB = createMockDB({ runResult: { success: true } });
        const statement = (mockDB as unknown as { _mockStatement: Record<string, unknown> })
          ._mockStatement;
        if (options.consentWrites !== undefined) {
          // The consent write is the first statement of the batch (its history follows).
          vi.mocked(mockDB.batch).mockImplementation(
            async (statements: unknown[]) =>
              statements.map((_, index) => ({
                success: true,
                meta: { changes: index === 0 ? options.consentWrites : 1 },
              })) as never
          );
        }
        vi.mocked(mockDB.prepare).mockImplementation((sql: string) => {
          if (sql.includes('SELECT generation, revoked_at FROM oauth_client_consent_revocations')) {
            return {
              ...statement,
              bind: vi.fn().mockReturnThis(),
              first: vi.fn(async () => {
                if (options.readFails?.()) throw new Error('D1_ERROR: no such table');
                return { generation: 4, revoked_at: 1 };
              }),
            } as never;
          }
          if (
            sql.includes('INSERT INTO oauth_client_consents') &&
            options.consentWrites !== undefined
          ) {
            return {
              ...statement,
              bind: vi.fn().mockReturnThis(),
              run: vi.fn(async () => ({
                success: true,
                meta: { changes: options.consentWrites },
              })),
            } as never;
          }
          return statement as never;
        });
        return mockDB;
      }

      it('keeps the consent screen usable when the generation cannot be read', async () => {
        const challengeStore = approvalChallenge();
        let fail = true;
        const db = accountDb({ readFails: () => fail });
        const approve = () =>
          consentPostHandler(
            createMockContext({
              method: 'POST',
              body: { challenge_id: 'consent-challenge-gen', approved: true },
              headers: { 'content-type': 'application/json' },
              challengeStore,
              db,
            })
          );

        const failed = await approve();
        expect(failed.status).toBe(503);
        expect(challengeStore._challenges.has('consent-challenge-gen')).toBe(true);

        fail = false;
        const retried = await approve();
        expect(retried.status).toBe(200);
        expect(challengeStore._challenges.has('consent-challenge-gen')).toBe(false);
      });

      it('records the approval under the generation read for it', async () => {
        const challengeStore = approvalChallenge();
        const c = createMockContext({
          method: 'POST',
          body: { challenge_id: 'consent-challenge-gen', approved: true },
          headers: { 'content-type': 'application/json' },
          challengeStore,
          db: accountDb(),
        });

        await consentPostHandler(c);

        const jsonBody = c.json.mock.calls[0][0] as { redirect_url: string };
        const confirmation = new URL(jsonBody.redirect_url, 'https://example.com').searchParams.get(
          '_consent_confirmation_challenge'
        );
        expect(challengeStore._challenges.get(confirmation!)).toMatchObject({
          metadata: { consent_generation: 4 },
        });
      });

      it('records nothing and asks to approve again when a withdrawal raced the approval', async () => {
        const challengeStore = approvalChallenge();
        const c = createMockContext({
          method: 'POST',
          body: { challenge_id: 'consent-challenge-gen', approved: true },
          headers: { 'content-type': 'application/json' },
          challengeStore,
          // The generation moved on before the conditional write: it writes no row.
          db: accountDb({ consentWrites: 0 }),
        });

        const response = await consentPostHandler(c);

        expect(response.status).toBe(409);
        await expect(response.json()).resolves.toMatchObject({ error: 'consent_withdrawn' });
        expect(
          [...challengeStore._challenges.values()].some(
            (challenge: { metadata?: { purpose?: string } }) =>
              challenge.metadata?.purpose === 'authorize_consent_confirmation'
          )
        ).toBe(false);
      });
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

      const response = await consentPostHandler(c);

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
          sessionId: 'g1:apac:3:session_user_123',
          browserBinding: expect.any(String),
          authorization_request: expect.objectContaining({
            response_type: 'code',
            client_id: 'test-client',
            scope: 'openid profile',
          }),
        },
      });
      expect(response.headers.get('Set-Cookie')).toContain('authrim_consent_confirmation=');
      expect(response.headers.get('Set-Cookie')).toContain('HttpOnly');
    });

    it('hands a re-authentication completed before consent back to /authorize', async () => {
      const confirmedReauth = { auth_time: 1_700_000_200, reauth_issued_at: 1_700_000_190_000 };
      const challengeStore = createMockChallengeStore({
        id: 'consent-challenge-after-reauth',
        type: 'consent',
        userId: 'user-123',
        metadata: {
          response_type: 'code',
          client_id: 'test-client',
          redirect_uri: 'https://example.com/callback',
          scope: 'openid profile',
          state: 'test-state',
          prompt: 'login',
          confirmed_reauth: confirmedReauth,
        },
      });
      const c = createMockContext({
        method: 'POST',
        body: { challenge_id: 'consent-challenge-after-reauth', approved: true },
        headers: { 'content-type': 'application/json' },
        challengeStore,
        db: createMockDB({ runResult: { success: true } }),
      });

      await consentPostHandler(c);

      const jsonBody = c.json.mock.calls[0][0] as { redirect_url: string };
      const confirmationChallenge = new URL(
        jsonBody.redirect_url,
        'https://example.com'
      ).searchParams.get('_consent_confirmation_challenge');
      expect(challengeStore._challenges.get(confirmationChallenge!)).toMatchObject({
        metadata: {
          purpose: 'authorize_consent_confirmation',
          confirmed_reauth: confirmedReauth,
          // The consent withdrawal generation the approval was given under (none withdrawn).
          consent_generation: 0,
        },
      });
    });

    it.each([
      ['submitted acting_as_user_id', {}, { acting_as_user_id: 'victim-user' }],
      ['challenge acting_as metadata', { acting_as: 'victim-user' }, {}],
    ])('rejects an unvalidated acting-as target from %s', async (_source, metadata, body) => {
      const challengeStore = createMockChallengeStore({
        id: 'invalid-acting-as-challenge',
        type: 'consent',
        userId: 'user-123',
        metadata: {
          response_type: 'code',
          client_id: 'test-client',
          redirect_uri: 'https://example.com/callback',
          scope: 'openid profile',
          ...metadata,
        },
      });
      const mockDB = createMockDB({ runResult: { success: true } });
      const c = createMockContext({
        method: 'POST',
        body: {
          challenge_id: 'invalid-acting-as-challenge',
          approved: true,
          ...body,
        },
        headers: { 'content-type': 'application/json' },
        challengeStore,
        db: mockDB,
        env: { ENABLE_RBAC_CONSENT_ACTING_AS: 'true' },
      });

      const response = await consentPostHandler(c);

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({ error: 'access_denied' });
      expect(mockValidateActingAsRelationship).toHaveBeenCalledWith(
        expect.anything(),
        'user-123',
        'victim-user',
        'default'
      );
      expect(mockDB.prepare).not.toHaveBeenCalledWith(
        expect.stringContaining('oauth_client_consents')
      );
    });

    it('preserves acting-as state after validating the delegated relationship', async () => {
      mockValidateActingAsRelationship.mockResolvedValue({
        valid: true,
        relationship_type: 'delegate',
        permission_level: 'manage',
      });
      const challengeStore = createMockChallengeStore({
        id: 'valid-acting-as-challenge',
        type: 'consent',
        userId: 'user-123',
        metadata: {
          response_type: 'code',
          client_id: 'test-client',
          redirect_uri: 'https://example.com/callback',
          scope: 'openid',
          acting_as: 'delegated-user',
        },
      });
      const c = createMockContext({
        method: 'POST',
        body: { challenge_id: 'valid-acting-as-challenge', approved: true },
        headers: { 'content-type': 'application/json' },
        challengeStore,
        env: { ENABLE_RBAC_CONSENT_ACTING_AS: 'true' },
      });

      await consentPostHandler(c);

      const response = c.json.mock.calls[0][0] as { redirect_url: string };
      const confirmationId = new URL(response.redirect_url, 'https://example.com').searchParams.get(
        '_consent_confirmation_challenge'
      );
      expect(challengeStore._challenges.get(confirmationId!)?.metadata).toMatchObject({
        authorization_request: expect.objectContaining({ acting_as: 'delegated-user' }),
      });
    });

    it('rejects acting-as consent when the feature is disabled', async () => {
      mockValidateActingAsRelationship.mockResolvedValue({
        valid: true,
        relationship_type: 'delegate',
        permission_level: 'manage',
      });
      const challengeStore = createMockChallengeStore({
        id: 'disabled-acting-as-challenge',
        type: 'consent',
        userId: 'user-123',
        metadata: {
          response_type: 'code',
          client_id: 'test-client',
          redirect_uri: 'https://example.com/callback',
          scope: 'openid',
          acting_as: 'delegated-user',
        },
      });
      const c = createMockContext({
        method: 'POST',
        body: { challenge_id: 'disabled-acting-as-challenge', approved: true },
        headers: { 'content-type': 'application/json' },
        challengeStore,
      });

      const response = await consentPostHandler(c);

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({ error: 'access_denied' });
      expect(mockValidateActingAsRelationship).not.toHaveBeenCalled();
    });

    it('answers 503 and records nothing when the account records cannot be read on approval', async () => {
      vi.mocked(getConsentItemsForScreen).mockRejectedValue(
        new StatementConsentAccountReadError(new Error('account database down'))
      );
      const challengeStore = createMockChallengeStore({
        id: 'consent-challenge-records-down',
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
      const c = createMockContext({
        method: 'POST',
        body: { challenge_id: 'consent-challenge-records-down', approved: true },
        headers: { 'content-type': 'application/json' },
        challengeStore,
        db: createMockDB({ runResult: { success: true } }),
      }) as unknown as Parameters<typeof consentPostHandler>[0];

      const response = await consentPostHandler(c);

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({ error: 'temporarily_unavailable' });
      expect(processConsentItemDecisions).not.toHaveBeenCalled();
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
        body: {
          challenge_id: 'consent-challenge-required',
          approved: true,
          consent_item_versions: {
            'stmt-required': { version_id: 'ver-required', content_hash: null },
          },
        },
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

    it.each(['missing', 'version', 'hash', 'removed'] as const)(
      'rejects a changed displayed document (%s) before recording consent',
      async (change) => {
        vi.mocked(getConsentItemsForScreen).mockResolvedValue(
          change === 'removed'
            ? []
            : [
                {
                  statement_id: 'stmt-required',
                  slug: 'terms',
                  category: 'terms_of_service',
                  legal_basis: 'consent',
                  title: 'Terms',
                  description: 'Terms',
                  version: '20260620',
                  version_id: 'ver-required',
                  content_hash: 'b'.repeat(64),
                  is_required: true,
                  enforcement: 'block',
                  needs_version_upgrade: false,
                  show_deletion_link: false,
                  display_order: 1,
                },
              ]
        );
        const challengeStore = createMockChallengeStore({
          id: 'changed-doc',
          type: 'consent',
          userId: 'user-123',
          metadata: {
            client_id: 'test-client',
            redirect_uri: 'https://example.com/callback',
            scope: 'openid profile',
            response_type: 'code',
          },
        });
        const c = createMockContext({
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          challengeStore,
          body: {
            challenge_id: 'changed-doc',
            approved: true,
            consent_item_decisions: { 'stmt-required': 'granted' },
            consent_item_versions:
              change === 'missing'
                ? undefined
                : {
                    'stmt-required': {
                      version_id: change === 'version' ? 'old-version' : 'ver-required',
                      content_hash: change === 'hash' ? 'c'.repeat(64) : 'b'.repeat(64),
                    },
                  },
          },
          db: createMockDB({ runResult: { success: true } }),
        }) as unknown as Parameters<typeof consentPostHandler>[0];
        const response = await consentPostHandler(c);
        expect(response.status).toBe(409);
        await expect(response.json()).resolves.toMatchObject({ error: 'document_changed' });
        expect(processConsentItemDecisions).not.toHaveBeenCalled();
        const stub = challengeStore.get() as {
          consumeChallengeRpc: unknown;
          getChallengeRpc(id: string): Promise<unknown>;
        };
        expect(stub.consumeChallengeRpc).not.toHaveBeenCalled();
        expect(await stub.getChallengeRpc('changed-doc')).not.toBeNull();
      }
    );

    it('issues a fresh session-bound consent challenge after a write-stage generation conflict', async () => {
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
          content_hash: 'b'.repeat(64),
          is_required: true,
          enforcement: 'block',
          needs_version_upgrade: false,
          show_deletion_link: false,
          display_order: 1,
        },
      ]);
      vi.mocked(processConsentItemDecisions).mockRejectedValueOnce(
        new Error('statement_consent_transition_rejected')
      );
      const expiresAt = Date.now() + 60_000;
      const challengeStore = createMockChallengeStore({
        id: 'racing-doc',
        type: 'consent',
        userId: 'user-123',
        expiresAt,
        metadata: {
          client_id: 'test-client',
          redirect_uri: 'https://example.com/callback',
          scope: 'openid profile',
          response_type: 'code',
        },
      });
      const c = createMockContext({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        challengeStore,
        body: {
          challenge_id: 'racing-doc',
          approved: true,
          consent_item_decisions: { 'stmt-required': 'granted' },
          consent_item_versions: {
            'stmt-required': { version_id: 'ver-required', content_hash: 'b'.repeat(64) },
          },
        },
        db: createMockDB({ runResult: { success: true } }),
      }) as unknown as Parameters<typeof consentPostHandler>[0];
      const response = await consentPostHandler(c);
      expect(response.status).toBe(409);
      const body: unknown = await response.json();
      expect(body).toMatchObject({ error: 'document_changed' });
      if (
        !body ||
        typeof body !== 'object' ||
        !('error_details' in body) ||
        !body.error_details ||
        typeof body.error_details !== 'object' ||
        !('consent_challenge_id' in body.error_details) ||
        typeof body.error_details.consent_challenge_id !== 'string'
      )
        throw new Error('replacement_consent_challenge_missing');
      const replacementId = body.error_details.consent_challenge_id;
      expect(replacementId).not.toBe('racing-doc');
      const stub = challengeStore.get() as { getChallengeRpc(id: string): Promise<unknown> };
      const stored = (await stub.getChallengeRpc(replacementId)) as {
        notAfterMs: number;
        metadata: { session_id: string };
        userId: string;
      };
      expect(stored.notAfterMs).toBe(expiresAt);
      expect(stored.metadata.session_id).toBe('g1:apac:3:session_user_123');
      expect(stored.userId).toBe('user-123');
    });

    it('accepts consent item decisions for required items', async () => {
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
      const accountDb = createMockDB({
        runResult: { success: true },
      });
      const c = createMockContext({
        method: 'POST',
        body: {
          challenge_id: 'consent-challenge-form-required',
          approved: true,
          consent_item_decisions: { 'stmt-required': 'granted' },
          consent_item_versions: {
            'stmt-required': { version_id: 'ver-required', content_hash: null },
          },
        },
        headers: { 'content-type': 'application/json' },
        challengeStore,
        db: mockDB,
        accountDb,
      });

      await consentPostHandler(c);

      // Definitions are read from the metadata database; the decision is recorded in the account's.
      const [stores] = vi.mocked(processConsentItemDecisions).mock.calls[0];
      const prepared = (db: unknown) => (db as { prepare: ReturnType<typeof vi.fn> }).prepare;
      prepared(mockDB).mockClear();
      prepared(accountDb).mockClear();
      await stores.account.query('SELECT 1');
      expect(prepared(accountDb)).toHaveBeenCalledTimes(1);
      expect(prepared(mockDB)).not.toHaveBeenCalled();
      await stores.metadata.query('SELECT 1');
      expect(prepared(mockDB)).toHaveBeenCalledTimes(1);

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
            content_hash: null,
            withdrawal_allowed: true,
          },
        },
        { env: (c as unknown as Parameters<typeof consentPostHandler>[0]).env }
      );
      expect(c.json).toHaveBeenCalledWith({
        redirect_url: expect.stringContaining('_consent_confirmation_challenge='),
      });
      expect(c.redirect).not.toHaveBeenCalled();
    });

    it('rejects form-encoded requests without consuming the challenge', async () => {
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

      const response = await consentPostHandler(c);

      expect(response.status).toBe(400);
      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'invalid_request' }),
        400
      );
      expect(c.redirect).not.toHaveBeenCalled();
      expect(challengeStore._challenges.has('consent-challenge-123')).toBe(true);
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
  describe('information release', () => {
    const CANDIDATES = [
      { name: 'email', required: true },
      { name: 'name', required: false },
      { name: 'phone_number', required: false },
    ];

    beforeEach(() => {
      releaseFixture.client = {
        client_id: 'test-client',
        information_release_consent: { enabled: true, ask: 'once', show_values: true },
      };
      releaseFixture.candidates = CANDIDATES;
      releaseFixture.values = { email: 'user@example.com', name: 'Example User' };
    });

    afterEach(() => {
      releaseFixture.client = undefined;
      releaseFixture.candidates = [];
      releaseFixture.values = {};
    });

    function challenge() {
      return createMockChallengeStore({
        id: 'consent-challenge-release',
        type: 'consent',
        userId: 'user-123',
        metadata: {
          response_type: 'code',
          client_id: 'test-client',
          redirect_uri: 'https://example.com/callback',
          scope: 'openid profile email',
          state: 'test-state',
        },
      });
    }

    async function key(candidates = CANDIDATES) {
      return releasePresentationKey(candidates, null);
    }

    it('shows what the app would be given, with the optional items and a presentation key', async () => {
      const mockDB = createMockDB({
        firstResult: {
          client_id: 'test-client',
          client_name: 'Test Application',
          logo_uri: null,
          client_uri: null,
          policy_uri: null,
          tos_uri: null,
          is_trusted: 0,
        },
      });
      const c = createMockContext({
        query: { challenge_id: 'consent-challenge-release' },
        challengeStore: challenge(),
        db: mockDB,
        accountDb: createMockDB({}),
      });

      const response = await consentGetHandler(c);

      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        information_release?: {
          items: Array<Record<string, unknown>>;
          show_values: boolean;
          presentation_key: string;
        };
      };
      expect(body.information_release?.show_values).toBe(true);
      expect(body.information_release?.presentation_key).toBe(await key());
      expect(body.information_release?.items).toEqual([
        expect.objectContaining({ name: 'email', required: true, value: 'user@example.com' }),
        expect.objectContaining({ name: 'name', required: false, previously_approved: false }),
        expect.objectContaining({ name: 'phone_number', required: false }),
      ]);
    });

    it('records the decision with its history, and carries the approval in the confirmation challenge', async () => {
      const challengeStore = challenge();
      const mockDB = createMockDB({ runResult: { success: true } });
      const c = createMockContext({
        method: 'POST',
        body: {
          challenge_id: 'consent-challenge-release',
          approved: true,
          release_selected: ['name'],
          release_presentation_key: await key(),
        },
        headers: { 'content-type': 'application/json' },
        challengeStore,
        db: mockDB,
      });

      await consentPostHandler(c);

      const jsonBody = c.json.mock.calls[0][0] as { redirect_url: string };
      const confirmation = new URL(jsonBody.redirect_url, 'https://example.com').searchParams.get(
        '_consent_confirmation_challenge'
      );
      // Required items and the optional one the user chose; the one left unticked is declined.
      expect(challengeStore._challenges.get(confirmation!)).toMatchObject({
        metadata: { release_approval: ['email', 'name'] },
      });
      // The consent write and its history are one batch (nothing recorded without the other).
      const sqls = vi.mocked(mockDB.prepare).mock.calls.map(([sql]) => sql);
      expect(sqls.some((sql) => sql.includes('INSERT INTO oauth_client_consents'))).toBe(true);
      expect(sqls.some((sql) => sql.includes('INSERT INTO consent_history'))).toBe(true);
      expect(mockDB.batch).toHaveBeenCalledTimes(1);
      const bound = JSON.stringify(
        (mockDB as unknown as { _mockStatement: { bind: { mock: { calls: unknown[] } } } })
          ._mockStatement.bind.mock.calls
      );
      // Approved: the required item and the one the user chose; declined: the one left unticked.
      expect(bound).toContain('[\\"email\\",\\"name\\"]');
      expect(bound).toContain('[\\"phone_number\\"]');
      expect(bound).toContain('user');
    });

    it('answers 409 document_changed, and records nothing, when the items shown are no longer the ones to approve', async () => {
      const challengeStore = challenge();
      const mockDB = createMockDB({ runResult: { success: true } });
      const stale = await key([{ name: 'email', required: true }]);
      const c = createMockContext({
        method: 'POST',
        body: {
          challenge_id: 'consent-challenge-release',
          approved: true,
          release_selected: ['name'],
          release_presentation_key: stale,
        },
        headers: { 'content-type': 'application/json' },
        challengeStore,
        db: mockDB,
      });

      const response = await consentPostHandler(c);

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({ error: 'document_changed' });
      expect(mockDB.batch).not.toHaveBeenCalled();
    });

    it('approves only the required items of an app that does not ask, and records that it was not asked', async () => {
      releaseFixture.client = {
        client_id: 'test-client',
        information_release_consent: { enabled: false, ask: 'once', show_values: false },
      };
      const challengeStore = challenge();
      const c = createMockContext({
        method: 'POST',
        body: { challenge_id: 'consent-challenge-release', approved: true },
        headers: { 'content-type': 'application/json' },
        challengeStore,
        db: createMockDB({ runResult: { success: true } }),
      });

      await consentPostHandler(c);

      const jsonBody = c.json.mock.calls[0][0] as { redirect_url: string };
      const confirmation = new URL(jsonBody.redirect_url, 'https://example.com').searchParams.get(
        '_consent_confirmation_challenge'
      );
      expect(challengeStore._challenges.get(confirmation!)).toMatchObject({
        metadata: { release_approval: ['@required'] },
      });
    });

    it('approves nothing, and keeps the empty answer, when there is nothing about the user to release', async () => {
      releaseFixture.candidates = [];
      const challengeStore = challenge();
      const c = createMockContext({
        method: 'POST',
        body: { challenge_id: 'consent-challenge-release', approved: true },
        headers: { 'content-type': 'application/json' },
        challengeStore,
        db: createMockDB({ runResult: { success: true } }),
      });

      await consentPostHandler(c);

      const jsonBody = c.json.mock.calls[0][0] as { redirect_url: string };
      const confirmation = new URL(jsonBody.redirect_url, 'https://example.com').searchParams.get(
        '_consent_confirmation_challenge'
      );
      expect(challengeStore._challenges.get(confirmation!)).toMatchObject({
        metadata: { release_approval: [] },
      });
    });
  });
});
