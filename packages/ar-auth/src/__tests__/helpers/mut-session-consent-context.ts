/**
 * Context builders for the mut-session-consent-* tests (consent POST handler). The module mocks
 * live in each test file. Mirrors the builders in consent.test.ts.
 */
import { vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core/types/env';

export const BOUND_SESSION = 'g1:apac:3:session_user_123';

export function createConsentDB() {
  const statement = {
    bind: vi.fn().mockReturnThis(),
    first: vi.fn().mockResolvedValue(null),
    all: vi.fn().mockResolvedValue({ results: [] }),
    run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 1 } }),
  };
  return {
    prepare: vi.fn().mockReturnValue(statement),
    batch: vi.fn(async (statements: unknown[]) =>
      statements.map(() => ({ success: true, meta: { changes: 1 } }))
    ),
    _statement: statement,
  } as unknown as D1Database & { _statement: typeof statement };
}

export function createConsentChallengeStore(challenge?: Record<string, unknown>) {
  const challenges = new Map<string, Record<string, unknown>>();
  if (challenge) {
    const metadata = (challenge.metadata ?? {}) as Record<string, unknown>;
    challenges.set(challenge.id as string, {
      ...challenge,
      metadata: { session_id: BOUND_SESSION, ...metadata },
    });
  }
  const stub = {
    storeChallengeRpc: vi.fn(async (request: { id: string }) => {
      challenges.set(request.id, request);
      return { success: true };
    }),
    consumeChallengeRpc: vi.fn(async (request: { id: string }) => {
      const data = challenges.get(request.id);
      if (!data) throw new Error('Challenge not found');
      challenges.delete(request.id);
      return data;
    }),
    getChallengeRpc: vi.fn(async (id: string) => challenges.get(id) ?? null),
  };
  return {
    idFromName: vi.fn().mockReturnValue({ toString: () => 'mock-id' }),
    get: vi.fn().mockReturnValue(stub),
    _stub: stub,
    _challenges: challenges,
  };
}

export function createConsentContext(options: {
  body: Record<string, unknown>;
  headers?: Record<string, string>;
  db?: D1Database;
  challengeStore: ReturnType<typeof createConsentChallengeStore>;
  env?: Record<string, unknown>;
}) {
  const db = options.db ?? createConsentDB();
  const contextStore = new Map<string, unknown>([
    ['tenantId', 'default'],
    [
      'tenantMetadataContext',
      {
        tenantId: 'default',
        coreDb: db,
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
        coreDb: db,
        piiDb: db,
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
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    cookie: `authrim_session=${encodeURIComponent(BOUND_SESSION)}`,
    ...Object.fromEntries(
      Object.entries(options.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value])
    ),
  };
  return {
    req: {
      method: 'POST',
      json: vi.fn(async () => options.body),
      header: vi.fn((name: string) => headers[name.toLowerCase()]),
    },
    env: {
      DB: db,
      ISSUER_URL: 'https://example.com',
      CHALLENGE_STORE: options.challengeStore,
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
    json: vi.fn(
      (body: unknown, status?: number) =>
        new Response(JSON.stringify(body), { status: status ?? 200 })
    ),
    redirect: vi.fn(
      (url: string, status: number) => new Response(null, { status, headers: { Location: url } })
    ),
    get: vi.fn((key: string) => contextStore.get(key)),
    set: vi.fn((key: string, value: unknown) => contextStore.set(key, value)),
  };
}
