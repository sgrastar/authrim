/**
 * Shared harness for the mut-directory-password-login-* tests. The test files call vi.mock with
 * factories that import this module dynamically, so every file shares one mock surface without
 * repeating ~150 lines of setup. Collaborators outside the handler are mocked so the handler's
 * own decisions (status, error code, failure reason, events) are what the tests observe.
 */
import { vi } from 'vitest';

export const TENANT = 'tenant-a';
export const WW_CONNECTOR = 'wwcon_8K4M2Q9F7D3H6P1X';
export const SUBJECT = 'uid=alice,ou=People,dc=example,dc=com';

export const m = {
  attemptMetadata: vi.fn(async (..._a: unknown[]): Promise<Record<string, string>> => ({})),
  failures: [] as Array<{ reason: string; userId: string | null | undefined }>,
  namedRefusal: vi.fn(async (..._a: unknown[]): Promise<Response | null> => null),
  sessionForChallenge: vi.fn(),
  readChallengeType: vi.fn(async (..._a: unknown[]): Promise<string | null> => 'login'),
  consumeContinuation: vi.fn(),
  humanVerification: vi.fn(async (..._a: unknown[]): Promise<Response | null> => null),
  flowCompletionRedirect: vi.fn(async (..._a: unknown[]): Promise<string | null> => null),
  usesRouted: vi.fn((..._a: unknown[]) => false),
  resolveDirectoryAccountRoute: vi.fn(),
  publishDirectoryRoute: vi.fn(),
  findById: vi.fn(),
  findByEmail: vi.fn(),
  coreAdapter: { query: vi.fn(), queryOne: vi.fn(), execute: vi.fn() },
  passkeys: { findByUserId: vi.fn(), create: vi.fn() },
  resolveByIdentifier: vi.fn(),
  ensureAuthState: vi.fn(),
  sessionStore: { createSessionRpc: vi.fn() },
  publishEvent: vi.fn(),
  createAuditLog: vi.fn(),
  migrationDecision: vi.fn(),
  markEnrolled: vi.fn(),
  rateLimiter: { incrementRpc: vi.fn(), resetRpc: vi.fn() },
  activeTransaction: vi.fn(),
  emailGate: vi.fn(async (..._a: unknown[]): Promise<Response | null> => null),
};

export function resetHarness() {
  vi.clearAllMocks();
  m.failures.length = 0;
  m.attemptMetadata.mockResolvedValue({});
  m.namedRefusal.mockResolvedValue(null);
  m.sessionForChallenge.mockResolvedValue({
    allowed: true,
    interactionId: null,
    profiled: { ttl: { seconds: 3600, milliseconds: 3_600_000 }, snapshot: { profile: 'p' } },
  });
  m.readChallengeType.mockResolvedValue('login');
  m.consumeContinuation.mockResolvedValue({ redirectUrl: 'https://rp.example/cb', type: 'login' });
  m.humanVerification.mockResolvedValue(null);
  m.flowCompletionRedirect.mockResolvedValue(null);
  m.usesRouted.mockReturnValue(false);
  m.findById.mockResolvedValue({
    id: 'user_1',
    email: 'alice@example.com',
    name: 'Alice',
    active: 1,
  });
  m.findByEmail.mockResolvedValue(null);
  m.coreAdapter.query.mockResolvedValue([]);
  m.coreAdapter.queryOne.mockResolvedValue({ user_id: 'user_1' });
  m.coreAdapter.execute.mockResolvedValue({ rowsAffected: 1, success: true });
  m.passkeys.findByUserId.mockResolvedValue([]);
  m.ensureAuthState.mockResolvedValue({ lifecycle: 'active' });
  m.sessionStore.createSessionRpc.mockResolvedValue({ id: 'sess_1' });
  m.publishEvent.mockResolvedValue(undefined);
  m.createAuditLog.mockResolvedValue(undefined);
  m.migrationDecision.mockResolvedValue({ action: 'none' });
  m.markEnrolled.mockResolvedValue(undefined);
  m.rateLimiter.incrementRpc.mockResolvedValue({ allowed: true });
  m.rateLimiter.resetRpc.mockResolvedValue(true);
  m.activeTransaction.mockResolvedValue(null);
  m.emailGate.mockResolvedValue(null);
}

type Original = () => Promise<Record<string, unknown>>;

export async function coreMock(importOriginal: Original) {
  const actual = await importOriginal();
  const authCtx = () => ({ coreAdapter: m.coreAdapter, repositories: { passkey: m.passkeys } });
  return {
    ...actual,
    getTenantIdFromContext: vi.fn(() => TENANT),
    getLogger: vi.fn(() => ({ module: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }) })),
    createAuthContextFromHono: vi.fn(authCtx),
    createAccountAuthContextFromHono: vi.fn(authCtx),
    createPIIContextFromHono: vi.fn(() => ({ defaultPiiAdapter: {} })),
    CanonicalRuntimeUserStore: class {
      findById = m.findById;
      findByEmail = m.findByEmail;
      findAccountAuthenticationState = vi.fn();
    },
    resolveAccountDataContextFromHono: vi.fn(async () => ({})),
    resolveAccountDataContextByIdentifierFromHono: m.resolveByIdentifier,
    ensureAccountAuthenticationState: m.ensureAuthState,
    getSessionStoreForNewSession: vi.fn(async () => ({
      stub: m.sessionStore,
      sessionId: 'sess_1',
    })),
    generateBrowserState: vi.fn(async () => 'browser-state'),
    publishEvent: m.publishEvent,
    createAuditLog: m.createAuditLog,
    getSessionCookieSameSite: vi.fn(() => 'Lax'),
    getBrowserStateCookieSameSite: vi.fn(() => 'Lax'),
    resolveAuthMaxFailedAttempts: vi.fn(async () => 5),
    resolvePostLoginRedirectUrl: vi.fn(async () => ({ redirectUrl: '/account' })),
    resolveDirectoryAuthMigrationDecision: m.migrationDecision,
    markDirectoryAuthMigrationUserEnrolled: m.markEnrolled,
    getActiveDirectoryAuthMigrationTransaction: m.activeTransaction,
    resolveEmailSendLimit: vi.fn(async () => ({ windowSeconds: 600, maxRequests: 3 })),
    getTenantSettingsDocument: vi.fn(async () => ({})),
    createTenantPlacementWriteFenceResponse: vi.fn(
      (c: { json: (b: unknown, s: number) => Response }, error: unknown) =>
        error instanceof Error && error.message === 'write_fenced'
          ? c.json({ error: 'tenant_write_fenced' }, 503)
          : null
    ),
  };
}

export function localMocks() {
  return {
    signInAttempt: async (orig: Original) => ({
      ...(await orig()),
      signInAttemptInteractionMetadata: m.attemptMetadata,
      signInAttemptFailureRecorder: vi.fn(
        () =>
          <T>(response: T, reason: string, userId?: string | null): T => {
            m.failures.push({ reason, userId });
            return response;
          }
      ),
    }),
    flowSession: async (orig: Original) => ({
      ...(await orig()),
      namedInteractionChallengeRefusal: m.namedRefusal,
      sessionForChallenge: m.sessionForChallenge,
    }),
    directAuth: async (orig: Original) => ({
      ...(await orig()),
      readAuthorizationChallengeType: m.readChallengeType,
      consumeAuthorizationChallengeContinuation: m.consumeContinuation,
    }),
    humanVerification: async (orig: Original) => ({
      ...(await orig()),
      verifyHumanVerificationForAction: m.humanVerification,
    }),
    registrationGate: async (orig: Original) => ({
      ...(await orig()),
      flowCompletionRedirect: m.flowCompletionRedirect,
    }),
    emailCodeGate: async (orig: Original) => ({
      ...(await orig()),
      rejectIfDirectoryEmailCodeDisabled: m.emailGate,
    }),
    accountProvisioning: async (orig: Original) => ({
      ...(await orig()),
      usesRoutedAccountStorage: m.usesRouted,
      resolveDirectoryAccountRoute: m.resolveDirectoryAccountRoute,
      publishDirectoryRoute: m.publishDirectoryRoute,
    }),
  };
}

export function connectorSettings(
  connector: Record<string, unknown> = {},
  config: Record<string, unknown> = {}
) {
  return {
    enabled: true,
    default_connector_id: 'campus',
    auto_provision: false,
    connectors: [
      {
        id: 'campus',
        endpoint_url: 'https://wordwarden.example.com',
        auth_mode: 'hmac',
        connector_id: WW_CONNECTOR,
        key_id: 'kid-active',
        secret_ref: 'env:WORDWARDEN_SECRET',
        ...connector,
      },
    ],
    ...config,
  };
}

export function createContext(
  body: unknown,
  options: {
    settings?: unknown;
    env?: Record<string, unknown>;
    headers?: Record<string, string>;
    url?: string;
  } = {}
) {
  const headers = new Headers();
  const settingsValue = options.settings === undefined ? connectorSettings() : options.settings;
  const requestHeaders: Record<string, string> = {
    'user-agent': 'Test Browser',
    'cf-connecting-ip': '203.0.113.10',
    ...Object.fromEntries(
      Object.entries(options.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])
    ),
  };
  const url = options.url ?? 'https://auth.example.com/api/auth/directory-password/login';
  const env = {
    SETTINGS: {
      get: vi.fn(async (key: string) => {
        if (key !== `settings:tenant:${TENANT}:directory-connectors`) return null;
        if (settingsValue === null) return null;
        return typeof settingsValue === 'string' ? settingsValue : JSON.stringify(settingsValue);
      }),
    },
    AUTHRIM_CONFIG: { get: vi.fn(async () => null) },
    WORDWARDEN_SECRET: 'active-secret',
    EMAIL_DOMAIN_HASH_SECRET: 'audit-hash-secret',
    RATE_LIMITER: {
      idFromName: vi.fn((name: string) => ({ name })),
      get: vi.fn(() => m.rateLimiter),
    },
    ...options.env,
  };
  return {
    req: {
      url,
      raw: new Request(url),
      json: vi.fn(async () => {
        if (body instanceof Error) throw body;
        return body;
      }),
      header: vi.fn((name: string) => requestHeaders[name.toLowerCase()]),
    },
    env,
    get: vi.fn(() => undefined),
    set: vi.fn(),
    executionCtx: { waitUntil: vi.fn() },
    header: (name: string, value: string) => headers.append(name, value),
    json: (payload: unknown, status = 200, extra?: Record<string, string>) => {
      const responseHeaders = new Headers(headers);
      for (const [k, v] of Object.entries(extra ?? {})) responseHeaders.set(k, v);
      return new Response(JSON.stringify(payload), { status, headers: responseHeaders });
    },
  };
}

export function verdictFetcher(
  verdict: Record<string, unknown> = {},
  onRequest?: (body: Record<string, unknown>) => void
) {
  return vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    onRequest?.(body);
    return Response.json({
      request_id: body.request_id,
      tenant_id: TENANT,
      connector_id: WW_CONNECTOR,
      result: 'success',
      subject: { directory_id: SUBJECT, username: 'alice' },
      attributes: { mail: ['alice@example.com'] },
      directory_status: 'ok',
      ...verdict,
    });
  });
}

export function failedEvents() {
  return m.publishEvent.mock.calls
    .map((call) => call[1] as { type: string; data: Record<string, unknown> })
    .filter((event) => event.type === 'auth.directory_password.failed')
    .map((event) => event.data);
}

export async function read(response: Response) {
  return { status: response.status, body: await response.json<Record<string, unknown>>() };
}
