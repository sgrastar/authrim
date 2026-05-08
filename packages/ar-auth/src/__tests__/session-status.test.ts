import { beforeEach, describe, expect, it, vi } from 'vitest';

const sessionStore = {
  getSessionRpc: vi.fn(),
};

vi.mock('hono/cookie', () => ({
  getCookie: vi.fn(() => '0_session_123'),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getSessionStoreBySessionId: vi.fn(() => ({ stub: sessionStore })),
    isShardedSessionId: vi.fn((sessionId: string) => /^\d+_session_/.test(sessionId)),
    hasPIIDatabase: vi.fn(() => false),
    getLogger: vi.fn(() => ({
      module: () => ({
        warn: vi.fn(),
        error: vi.fn(),
      }),
    })),
  };
});

function createContext() {
  return {
    env: {},
    json: (payload: unknown, status = 200) =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
  };
}

describe('session status OIDC assurance metadata', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns auth_time, acr, and amr for active managed browser sessions', async () => {
    sessionStore.getSessionRpc.mockResolvedValue({
      id: '0_session_123',
      userId: 'user_123',
      createdAt: 1700000000000,
      expiresAt: Date.now() + 60_000,
      data: {
        authTime: 1700000123,
        acr: 'urn:mace:incommon:iap:bronze',
        amr: ['passkey'],
      },
    });
    const { sessionStatusHandler } = await import('../session-management');

    const response = await sessionStatusHandler(createContext() as never);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      active: true,
      session_id: '0_session_123',
      user_id: 'user_123',
      auth_time: 1700000123,
      acr: 'urn:mace:incommon:iap:bronze',
      amr: ['passkey'],
    });
  });
});
