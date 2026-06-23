import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDirectoryPasswordLoginHandler } from '../directory-password-login';

const liveIntegrationEnabled = process.env.AUTHRIM_WORDWARDEN_LIVE_INTEGRATION === '1';

const mocks = vi.hoisted(() => ({
  findByEmail: vi.fn(),
  findById: vi.fn(),
  syncUser: vi.fn(),
  sessionStore: {
    createSessionRpc: vi.fn(),
  },
  getSessionStoreForNewSession: vi.fn(),
  generateUserIdFromSettings: vi.fn(),
  generateBrowserState: vi.fn(),
  publishEvent: vi.fn(),
  createAuditLog: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    CanonicalRuntimeUserStore: class {
      findByEmail = mocks.findByEmail;
      findById = mocks.findById;
      syncUser = mocks.syncUser;
    },
    createAuthContextFromHono: vi.fn(() => ({ coreAdapter: {} })),
    createPIIContextFromHono: vi.fn(() => ({ defaultPiiAdapter: {} })),
    getTenantIdFromContext: vi.fn(() => 'tenant-a'),
    getSessionStoreForNewSession: mocks.getSessionStoreForNewSession,
    generateUserIdFromSettings: mocks.generateUserIdFromSettings,
    generateBrowserState: mocks.generateBrowserState,
    publishEvent: mocks.publishEvent,
    createAuditLog: mocks.createAuditLog,
    getSessionCookieSameSite: vi.fn(() => 'Lax'),
    getBrowserStateCookieSameSite: vi.fn(() => 'Lax'),
    getLogger: vi.fn(() => ({
      module: () => ({
        warn: vi.fn(),
        error: vi.fn(),
      }),
    })),
  };
});

function createKV(values: Record<string, unknown>) {
  return {
    get: vi.fn(async (key: string) => {
      const value = values[key];
      return value === undefined ? null : JSON.stringify(value);
    }),
  };
}

function createContext() {
  const headers = new Headers();
  const env = {
    AUTHRIM_CONFIG: createKV({
      'settings:tenant:tenant-a:authentication-methods': {
        'authentication-methods.directory_password.enabled': true,
        'authentication-methods.directory_password.connector_id': 'campus',
        'authentication-methods.directory_password.auto_provision': true,
      },
      'settings:tenant:tenant-a:directory-connectors': {
        connectors: [
          {
            id: 'campus',
            endpoint_url: 'http://127.0.0.1:8080',
            auth_mode: 'hmac',
            connector_id: 'ww_tenant_a',
            key_id: 'kid-active',
            secret_ref: 'env:WORDWARDEN_SECRET',
            timeouts: {
              request_ms: 3000,
            },
            attribute_names: ['mail', 'displayName', 'uid'],
          },
        ],
      },
    }),
    WORDWARDEN_SECRET: 'active-secret',
  };

  return {
    req: {
      url: 'https://auth.example.com/api/auth/directory-password/login',
      json: vi.fn(async () => ({ username: 'alice', password: 'password' })),
      header: vi.fn((name: string) => {
        const lower = name.toLowerCase();
        if (lower === 'user-agent') return 'Live Wordwarden Test';
        if (lower === 'cf-connecting-ip') return '127.0.0.1';
        return undefined;
      }),
    },
    env,
    header: (name: string, value: string) => {
      headers.append(name, value);
    },
    json: (payload: unknown, status = 200) =>
      new Response(JSON.stringify(payload), {
        status,
        headers,
      }),
  };
}

describe.runIf(liveIntegrationEnabled)('directory password live Wordwarden integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findByEmail.mockResolvedValue(null);
    mocks.findById.mockResolvedValue({
      id: 'user_live_wordwarden',
      email: 'alice@example.com',
      name: 'Alice Example',
    });
    mocks.syncUser.mockResolvedValue({ userId: 'user_live_wordwarden' });
    mocks.getSessionStoreForNewSession.mockResolvedValue({
      stub: mocks.sessionStore,
      sessionId: 'sess_live_wordwarden',
    });
    mocks.generateUserIdFromSettings.mockResolvedValue('user_live_wordwarden');
    mocks.generateBrowserState.mockResolvedValue('browser-state-live');
    mocks.sessionStore.createSessionRpc.mockResolvedValue({ id: 'sess_live_wordwarden' });
    mocks.publishEvent.mockResolvedValue(undefined);
    mocks.createAuditLog.mockResolvedValue(undefined);
  });

  it('verifies alice/password through Wordwarden and creates an Authrim session', async () => {
    const handler = createDirectoryPasswordLoginHandler();

    const response = await handler(createContext() as never);
    const body = (await response.json()) as {
      ok?: boolean;
      session?: { amr?: string[] };
      user?: { email?: string };
    };

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.user?.email).toBe('alice@example.com');
    expect(body.session?.amr).toEqual(['pwd', 'directory']);
    expect(mocks.syncUser).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'alice@example.com',
        name: 'Alice Example',
        sourceRef: 'directory:campus',
        externalId: 'uid=alice,ou=People,dc=example,dc=com',
      })
    );
    expect(mocks.sessionStore.createSessionRpc).toHaveBeenCalledWith(
      'sess_live_wordwarden',
      'user_live_wordwarden',
      86400,
      expect.objectContaining({
        amr: ['pwd', 'directory'],
        directory_connector_id: 'campus',
      }),
      'tenant-a'
    );
    expect(response.headers.get('set-cookie')).toContain('authrim_session=sess_live_wordwarden');
  });
});
