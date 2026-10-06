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
    batch: vi.fn().mockResolvedValue([]),
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
        coreDb: mockDB,
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

    it('reads policy versions from tenant metadata and the existing consent from the account', async () => {
      const challengeStore = createMockChallengeStore({
        id: 'consent-challenge-versioning',
        type: 'consent',
        userId: 'user-123',
        metadata: {
          client_id: 'test-client',
          scope: 'openid profile',
          redirect_uri: 'https://example.com/callback',
          state: 'test-state',
        },
      });
      // Each database answers only the queries it owns.
      const sqlAwareDB = (answer: (sql: string, op: 'first' | 'all') => unknown) =>
        ({
          prepare: vi.fn((sql: string) => {
            const statement = {
              bind: vi.fn(() => statement),
              first: vi.fn(async () => answer(sql, 'first') ?? null),
              all: vi.fn(async () => ({ results: (answer(sql, 'all') as unknown[]) ?? [] })),
              run: vi.fn(async () => ({ success: true })),
            };
            return statement;
          }),
          batch: vi.fn().mockResolvedValue([]),
        }) as unknown as D1Database;
      const metadataDB = sqlAwareDB((sql, op) => {
        if (op === 'first' && sql.includes('oauth_clients')) {
          return { client_id: 'test-client', client_name: 'Test Application', is_trusted: 0 };
        }
        if (op === 'all' && sql.includes('FROM consent_policy_versions')) {
          return [
            {
              policy_type: 'privacy_policy',
              version: 'v2',
              policy_uri: 'https://example.com/privacy',
              effective_at: 1,
            },
          ];
        }
        return undefined;
      });
      const accountDB = sqlAwareDB((sql, op) => {
        if (op === 'all' && sql.includes('FROM oauth_client_consents')) {
          return [{ privacy_policy_version: 'v1', tos_version: null, consent_version: 1 }];
        }
        return undefined;
      });
      const c = createMockContext({
        query: { challenge_id: 'consent-challenge-versioning' },
        headers: { accept: 'application/json' },
        challengeStore,
        db: metadataDB,
        env: { CONSENT_VERSIONING_ENABLED: 'true' },
      });
      c.set('accountDataContext', {
        ...c.get('accountDataContext'),
        coreDb: accountDB,
        piiDb: accountDB,
      });

      await consentGetHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          versioning: {
            requiresReconsent: true,
            changedPolicies: ['privacy_policy'],
            currentVersions: {
              privacyPolicy: { version: 'v2', policyUri: 'https://example.com/privacy' },
            },
          },
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
      const c = createMockContext({
        method: 'POST',
        body: {
          challenge_id: 'consent-challenge-form-required',
          approved: true,
          consent_item_decisions: { 'stmt-required': 'granted' },
        },
        headers: { 'content-type': 'application/json' },
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
});
