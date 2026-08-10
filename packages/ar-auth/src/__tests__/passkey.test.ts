/**
 * Passkey Handlers Unit Tests
 *
 * Tests for WebAuthn passkey authentication including:
 * - Registration options generation
 * - Registration verification
 * - Login options generation
 * - Login verification
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Env } from '@authrim/ar-lib-core/types/env';
import {
  passkeyRegisterOptionsHandler,
  passkeyLoginOptionsHandler,
  passkeyRegisterVerifyHandler,
  passkeyLoginVerifyHandler,
} from '../passkey';

// Define mock functions using vi.hoisted for proper ESM module mocking
const mockWebAuthnFunctions = vi.hoisted(() => ({
  generateRegistrationOptions: vi.fn(),
  generateAuthenticationOptions: vi.fn(),
  verifyRegistrationResponse: vi.fn(),
  verifyAuthenticationResponse: vi.fn(),
}));

const mockIsoBase64URL = vi.hoisted(() => ({
  isBase64URL: vi.fn(),
  isBase64: vi.fn(),
  trimPadding: vi.fn(),
  fromBuffer: vi.fn(),
  toBuffer: vi.fn(),
  toBase64: vi.fn(),
  fromUTF8String: vi.fn(),
}));

// Use vi.hoisted for mocks that are referenced in vi.mock()
const mockSessionStoreStub = vi.hoisted(() => ({
  createSessionRpc: vi.fn(),
}));

const mockAccountAuthStateStub = vi.hoisted(() => ({
  getAccountStateRpc: vi.fn(),
  initializeAccountStateRpc: vi.fn(),
  advancePasskeyCounterRpc: vi.fn(),
}));

const mockAdvancePasskeyAuthenticationState = vi.hoisted(() => vi.fn());

const mockChallengeStoreStub = vi.hoisted(() => ({
  storeChallengeRpc: vi.fn(),
  consumeChallengeRpc: vi.fn(),
  getChallengeRpc: vi.fn(),
  deleteChallengeRpc: vi.fn(),
}));

// Repository mocks for D1Adapter pattern - defined at module level for easy access
const mockUserCoreRepository = {
  findById: vi.fn().mockResolvedValue(null),
  findByEmail: vi.fn().mockResolvedValue(null),
  createUser: vi.fn().mockResolvedValue('new-user-id'),
  update: vi.fn().mockResolvedValue(true),
  updatePIIStatus: vi.fn().mockResolvedValue(true),
  updateLastLogin: vi.fn().mockResolvedValue(true),
};
const mockUserPIIRepository = {
  findByTenantAndEmail: vi.fn().mockResolvedValue(null),
  findById: vi.fn().mockResolvedValue(null),
  createPII: vi.fn().mockResolvedValue('new-user-id'),
  update: vi.fn().mockResolvedValue(true),
};
const mockPasskeyRepository = {
  findByUserId: vi.fn().mockResolvedValue([]),
  findByCredentialId: vi.fn().mockResolvedValue(null),
  create: vi.fn().mockResolvedValue('new-passkey-id'),
  updateCounter: vi.fn().mockResolvedValue(true),
  updateCounterAfterAuth: vi.fn().mockResolvedValue(true),
  mirrorCounterAfterAuth: vi.fn().mockResolvedValue(true),
};
const mockCoreAdapter = {
  execute: vi.fn().mockResolvedValue({ rowsAffected: 1 }),
  queryOne: vi.fn().mockResolvedValue(null),
  query: vi.fn().mockResolvedValue([]),
};

// Create context return values
const mockAuthContext = {
  repositories: {
    userCore: mockUserCoreRepository,
    passkey: mockPasskeyRepository,
  },
  coreAdapter: mockCoreAdapter,
};
const mockPIIContext = {
  piiRepositories: {
    userPII: mockUserPIIRepository,
  },
};

// Mock @simplewebauthn/server
vi.mock('@simplewebauthn/server', () => mockWebAuthnFunctions);

// Mock @simplewebauthn/server/helpers
vi.mock('@simplewebauthn/server/helpers', () => ({
  isoBase64URL: mockIsoBase64URL,
}));

// Mock @authrim/ar-lib-core specific submodules for ESM barrel export resolution
vi.mock('@authrim/ar-lib-core/utils/id', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core/utils/id')>();
  return {
    ...actual,
    generateUserIdFromSettings: vi.fn(
      async () => `user-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`
    ),
  };
});

// Mock @authrim/ar-lib-core module
vi.mock('@authrim/ar-lib-core', async () => {
  const actual = await vi.importActual('@authrim/ar-lib-core');
  return {
    ...actual,
    CanonicalRuntimeUserStore: class {
      async findById(userId: string) {
        const core = await mockUserCoreRepository.findById(userId);
        if (!core || core.is_active === false) return null;
        const pii = await mockUserPIIRepository.findById(userId);
        return {
          id: core.id,
          account_type: core.user_type === 'admin' ? 'admin' : 'user',
          active: core.is_active === false ? 0 : 1,
          email: pii?.email ?? null,
          name: pii?.name ?? null,
          email_verified: core.email_verified ? 1 : 0,
          phone_number_verified: core.phone_number_verified ? 1 : 0,
          created_at: new Date(core.created_at ?? Date.now()).toISOString(),
          updated_at: new Date(core.updated_at ?? Date.now()).toISOString(),
          last_login_at: core.last_login_at ?? null,
        };
      }
      async findByEmail(email: string) {
        const pii = await mockUserPIIRepository.findByTenantAndEmail('default', email);
        if (!pii) return null;
        return this.findById(pii.id);
      }
      async findAccountAuthenticationState(userId: string) {
        const core = await mockUserCoreRepository.findById(userId);
        if (!core) return null;
        return {
          userId,
          accountType: core.user_type === 'admin' ? 'admin' : 'user',
          lifecycle: core.is_active === false ? 'inactive' : 'active',
          sourceVersionMs: 1_000,
        };
      }
      async findAuthenticationResponseUser(userId: string) {
        const core = await mockUserCoreRepository.findById(userId);
        const pii = await mockUserPIIRepository.findById(userId);
        return {
          id: userId,
          email: pii?.email ?? null,
          name: pii?.name ?? null,
          emailVerified: core?.email_verified ? 1 : 0,
          createdAt: new Date(core?.created_at ?? Date.now()).toISOString(),
          updatedAt: new Date(core?.updated_at ?? Date.now()).toISOString(),
          lastLoginAt: core?.last_login_at ?? null,
        };
      }
      async syncUser(input: { userId: string; email?: string | null; name?: string | null }) {
        await mockUserCoreRepository.createUser({
          id: input.userId,
          tenant_id: 'default',
          email_verified: false,
          user_type: 'end_user',
        });
        await mockUserPIIRepository.createPII({
          id: input.userId,
          tenant_id: 'default',
          email: input.email,
          name: input.name,
        });
        await mockUserCoreRepository.updatePIIStatus(input.userId, 'active');
        return { created: true, graph: null, profileAttributeCount: 0, contactPointCount: 0 };
      }
      async markEmailVerified(userId: string) {
        await mockCoreAdapter.execute('', [Date.now(), userId, 'default']);
        return true;
      }
      async touchLastLogin(userId: string) {
        await mockUserCoreRepository.updateLastLogin(userId);
        return true;
      }
      async deleteUser() {
        return true;
      }
    },
    getSessionStoreForNewSession: () =>
      Promise.resolve({
        stub: mockSessionStoreStub,
        sessionId: 'mock-session-id',
      }),
    getChallengeStoreByUserId: () => Promise.resolve(mockChallengeStoreStub),
    getChallengeStoreByChallengeId: () => Promise.resolve(mockChallengeStoreStub),
    // Repository pattern mocks - return the pre-defined context objects
    createAuthContextFromHono: () => mockAuthContext,
    createAccountAuthContextFromHono: () => mockAuthContext,
    createPIIContextFromHono: () => mockPIIContext,
    resolveAccountDataContextFromHono: vi.fn().mockResolvedValue({}),
    getTenantIdFromContext: () => 'default',
    advancePasskeyAuthenticationState: mockAdvancePasskeyAuthenticationState,
    resolveCustomClaimRuntimeSourcesFromEnv: vi.fn(async (env: Partial<Env>) => ({
      storageProfile: {
        id: 'builtin:storage:standard',
        kind: 'storage',
        label: 'Standard D1 Split',
        slices: {},
      },
      schemaDb: env.DB,
      nonPiiDb: env.DB,
      piiDb: env.DB_PII ?? null,
    })),
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
function createMockChallengeStore() {
  const challenges = new Map<string, any>();

  return {
    idFromName: vi.fn().mockReturnValue({ toString: () => 'mock-id' }),
    get: vi.fn().mockReturnValue({
      // RPC methods
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
        const had = challenges.has(id);
        challenges.delete(id);
        return { deleted: had };
      }),
      // Legacy fetch method (for backward compatibility in tests)
      fetch: vi.fn().mockImplementation(async (request: Request) => {
        const url = new URL(request.url);
        const path = url.pathname;

        // POST /challenge - Store challenge
        if (request.method === 'POST' && path === '/challenge') {
          const body = (await request.json()) as { id: string };
          challenges.set(body.id, body);
          return new Response(JSON.stringify({ success: true }));
        }

        // POST /challenge/consume - Atomic get and delete
        if (request.method === 'POST' && path === '/challenge/consume') {
          const body = (await request.json()) as { id: string };
          const data = challenges.get(body.id);
          if (data) {
            challenges.delete(body.id);
            return new Response(JSON.stringify(data));
          }
          return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
        }

        // GET /challenge/:id
        if (request.method === 'GET') {
          const id = url.searchParams.get('id') ?? path.split('/').pop() ?? '';
          const data = challenges.get(id);
          if (data) {
            return new Response(JSON.stringify(data));
          }
          return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
        }

        // DELETE /challenge/:id
        if (request.method === 'DELETE') {
          const id = url.searchParams.get('id') ?? path.split('/').pop() ?? '';
          challenges.delete(id);
          return new Response(JSON.stringify({ success: true }));
        }

        return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
      }),
    }),
    _challenges: challenges,
  };
}

// Helper to create mock SessionStore DO
function createMockSessionStore() {
  return {
    idFromName: vi.fn().mockReturnValue({ toString: () => 'mock-session-id' }),
    get: vi.fn().mockReturnValue({
      fetch: vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            success: true,
            session: {
              id: 'session-123',
              userId: 'user-123',
              authTime: Date.now(),
              amr: ['webauthn'],
            },
          })
        )
      ),
    }),
  };
}

// Helper to create mock context
function createMockContext(options: {
  method?: string;
  body?: Record<string, unknown>;
  headers?: Record<string, string>;
  url?: string;
  db?: D1Database;
  dbPII?: D1Database;
  challengeStore?: ReturnType<typeof createMockChallengeStore>;
  sessionStore?: ReturnType<typeof createMockSessionStore>;
}) {
  const mockDB =
    options.db ??
    createMockDB({
      firstResult: null,
      allResults: [],
    });

  // DB_PII mock for PII/Non-PII DB separation
  const mockDBPII =
    options.dbPII ??
    createMockDB({
      firstResult: null,
      allResults: [],
    });

  const challengeStore = options.challengeStore ?? createMockChallengeStore();
  const sessionStore = options.sessionStore ?? createMockSessionStore();

  // Store context values (simulating Hono's context store)
  const contextStore = new Map<string, unknown>([['tenantId', 'default']]);

  const c = {
    req: {
      method: options.method || 'POST',
      url:
        options.url ??
        (() => {
          const host = options.headers?.host ?? 'example.com';
          const isLocalhost =
            host.startsWith('localhost') || host.startsWith('127.0.0.1') || host.startsWith('::1');
          const protocol = isLocalhost ? 'http' : 'https';
          return `${protocol}://${host}/api/auth/passkeys/test`;
        })(),
      json: vi.fn().mockResolvedValue(options.body ?? {}),
      header: vi.fn().mockImplementation((name: string) => {
        return options.headers?.[name.toLowerCase()] ?? null;
      }),
    },
    env: {
      DB: mockDB,
      DB_PII: mockDBPII, // Added for PII/Non-PII DB separation
      ISSUER_URL: 'https://example.com',
      ALLOWED_ORIGINS: 'https://example.com',
      CHALLENGE_STORE: challengeStore,
      SESSION_STORE: sessionStore,
      SESSION_REVOCATION_STORE: {
        idFromName: vi.fn((name: string) => name),
        get: vi.fn(() => mockAccountAuthStateStub),
      },
    } as unknown as Env,
    json: vi.fn((body, status = 200) => new Response(JSON.stringify(body), { status })),
    header: vi.fn(),
    get: vi.fn((key: string) => contextStore.get(key)),
    set: vi.fn((key: string, value: unknown) => contextStore.set(key, value)),
    executionCtx: {
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
      props: {},
    },
    _mockDB: mockDB,
    _mockDBPII: mockDBPII, // For test assertions
    _challengeStore: challengeStore,
    _sessionStore: sessionStore,
  } as any;

  return c;
}

describe('Passkey Handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Setup WebAuthn mock implementations
    mockWebAuthnFunctions.generateRegistrationOptions.mockResolvedValue({
      challenge: 'mock-challenge-base64',
      rp: { name: 'Test RP', id: 'example.com' },
      user: {
        id: 'user-id-base64',
        name: 'test@example.com',
        displayName: 'Test User',
      },
      pubKeyCredParams: [{ alg: -7, type: 'public-key' }],
      timeout: 60000,
      attestation: 'none',
      authenticatorSelection: {
        residentKey: 'required',
        userVerification: 'required',
      },
    });

    mockWebAuthnFunctions.generateAuthenticationOptions.mockResolvedValue({
      challenge: 'mock-auth-challenge-base64',
      timeout: 60000,
      rpId: 'example.com',
      allowCredentials: [],
      userVerification: 'required',
    });

    mockWebAuthnFunctions.verifyRegistrationResponse.mockResolvedValue({
      verified: true,
      registrationInfo: {
        credentialID: 'mock-credential-id',
        credentialPublicKey: new Uint8Array([1, 2, 3, 4]),
        counter: 0,
        credentialDeviceType: 'singleDevice',
        credentialBackedUp: false,
        aaguid: '00000000-0000-0000-0000-000000000000',
        attestationObject: new Uint8Array([5, 6, 7, 8]),
      },
    });

    mockWebAuthnFunctions.verifyAuthenticationResponse.mockResolvedValue({
      verified: true,
      authenticationInfo: {
        credentialID: 'mock-credential-id',
        newCounter: 1,
        credentialDeviceType: 'singleDevice',
        credentialBackedUp: false,
      },
    });

    // Reset session store mock
    mockSessionStoreStub.createSessionRpc.mockReset();
    mockSessionStoreStub.createSessionRpc.mockResolvedValue({
      id: 'mock-session-id',
      userId: 'user-123',
      authTime: Date.now(),
      amr: ['passkey'],
    });

    // Reset challenge store mock
    mockChallengeStoreStub.storeChallengeRpc.mockReset();
    mockChallengeStoreStub.storeChallengeRpc.mockResolvedValue({ success: true });
    mockChallengeStoreStub.consumeChallengeRpc.mockReset();
    mockChallengeStoreStub.consumeChallengeRpc.mockResolvedValue({
      challenge: 'mock-challenge',
      userId: 'user-123',
      metadata: {},
    });
    mockChallengeStoreStub.getChallengeRpc.mockReset();
    mockChallengeStoreStub.getChallengeRpc.mockResolvedValue({
      id: 'test-id',
      type: 'passkey_registration',
      challenge: 'mock-challenge',
      userId: 'user-123',
      metadata: {},
    });

    // Setup isoBase64URL mock implementations
    mockIsoBase64URL.isBase64URL.mockReturnValue(true);
    mockIsoBase64URL.isBase64.mockReturnValue(false);
    mockIsoBase64URL.trimPadding.mockImplementation((input: string) => input);
    mockIsoBase64URL.fromBuffer.mockImplementation(() => 'mock-base64url-string');
    mockIsoBase64URL.toBuffer.mockImplementation(() => new Uint8Array([1, 2, 3, 4]));
    mockIsoBase64URL.toBase64.mockImplementation((input: string) => input);
    mockIsoBase64URL.fromUTF8String.mockImplementation((input: string) => input);

    // Reset Repository mocks to default values
    mockUserCoreRepository.findById.mockReset().mockResolvedValue(null);
    mockUserCoreRepository.createUser.mockReset().mockResolvedValue('new-user-id');
    mockUserCoreRepository.updatePIIStatus.mockReset().mockResolvedValue(true);
    mockUserCoreRepository.updateLastLogin.mockReset().mockResolvedValue(true);
    mockUserPIIRepository.findByTenantAndEmail.mockReset().mockResolvedValue(null);
    mockUserPIIRepository.findById.mockReset().mockResolvedValue(null);
    mockUserPIIRepository.createPII.mockReset().mockResolvedValue('new-user-id');
    mockPasskeyRepository.findByUserId.mockReset().mockResolvedValue([]);
    mockPasskeyRepository.findByCredentialId.mockReset().mockResolvedValue(null);
    mockPasskeyRepository.create.mockReset().mockResolvedValue('new-passkey-id');
    mockPasskeyRepository.updateCounterAfterAuth.mockReset().mockResolvedValue(true);
    mockPasskeyRepository.mirrorCounterAfterAuth.mockReset().mockResolvedValue(true);
    mockAccountAuthStateStub.getAccountStateRpc.mockReset().mockResolvedValue({
      revokedAfterMs: null,
      lastLoginAtMs: null,
      lifecycle: null,
      lifecycleVersionMs: null,
      lifecycleOperationId: null,
    });
    mockAccountAuthStateStub.initializeAccountStateRpc
      .mockReset()
      .mockImplementation(
        async (_tenantId: string, _userId: string, _accountId: string, lifecycle: string) => ({
          revokedAfterMs: null,
          lastLoginAtMs: null,
          lifecycle,
          lifecycleVersionMs: 1_000,
          lifecycleOperationId: null,
        })
      );
    mockAccountAuthStateStub.advancePasskeyCounterRpc
      .mockReset()
      .mockResolvedValue({ counter: 1, advanced: true });
    mockAdvancePasskeyAuthenticationState.mockReset().mockImplementation(
      async (
        _env: unknown,
        input: {
          tenantId: string;
          userId: string;
          credentialId: string;
          storedCounter: number;
          observedCounter: number;
          observedAtMs: number;
        },
        loader: () => Promise<{ lifecycle: string } | null>
      ) => {
        const account = await loader();
        if (!account || account.lifecycle !== 'active') {
          throw new Error('account_authentication_not_allowed');
        }
        return mockAccountAuthStateStub.advancePasskeyCounterRpc(
          input.tenantId,
          input.userId,
          `account:${input.userId}`,
          input.credentialId,
          input.storedCounter,
          input.observedCounter,
          input.observedAtMs
        );
      }
    );
    mockCoreAdapter.execute.mockReset().mockResolvedValue({ rowsAffected: 1 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('passkeyRegisterOptionsHandler', () => {
    it('should allow discoverable registration without email', async () => {
      const c = createMockContext({
        body: {},
        headers: { origin: 'https://example.com' },
      });

      const response = await passkeyRegisterOptionsHandler(c);

      expect(response.status).toBe(200);
      expect(mockWebAuthnFunctions.generateRegistrationOptions).toHaveBeenCalledWith(
        expect.objectContaining({
          userName: expect.any(String),
          userDisplayName: expect.any(String),
        })
      );
    });

    it('should reject unauthorized origins', async () => {
      const c = createMockContext({
        body: { email: 'test@example.com' },
        headers: { origin: 'https://malicious.com' },
      });

      const response = await passkeyRegisterOptionsHandler(c);

      expect(response.status).toBe(403);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe('access_denied');
    });

    it('should reject requests without origin header', async () => {
      const c = createMockContext({
        body: { email: 'test@example.com' },
        headers: {},
      });

      const response = await passkeyRegisterOptionsHandler(c);

      expect(response.status).toBe(403);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe('access_denied');
    });

    it('should allow same-origin requests even when not listed in allowed origins', async () => {
      const c = createMockContext({
        body: { email: 'tenant-user@example.com' },
        headers: {
          host: 'first.multi-tenant.authrim.com',
          origin: 'https://first.multi-tenant.authrim.com',
        },
      });

      c.env.ALLOWED_ORIGINS = 'https://admin.multi-tenant.authrim.com';

      const response = await passkeyRegisterOptionsHandler(c);

      expect(response.status).toBe(200);
      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            challenge: expect.any(String),
          }),
          userId: expect.any(String),
        })
      );
    });

    it('should generate registration options for new user', async () => {
      // Setup: No existing user found via Repository
      mockUserPIIRepository.findByTenantAndEmail.mockResolvedValueOnce(null);

      const c = createMockContext({
        body: { email: 'newuser@example.com' },
        headers: { origin: 'https://example.com' },
      });

      await passkeyRegisterOptionsHandler(c);

      // Should create new user via Repository
      expect(mockUserCoreRepository.createUser).toHaveBeenCalledWith(
        expect.objectContaining({
          tenant_id: 'default',
          email_verified: false,
          user_type: 'end_user',
        })
      );
      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            challenge: expect.any(String),
          }),
          userId: expect.any(String),
        })
      );
    });

    it('should return missing_required_fields when registration fields are required', async () => {
      const db = createMockDB({
        allResults: [
          {
            field_key: 'department',
            display_label: 'Department',
            field_type: 'string',
            registration_required: 1,
            validation_rules: null,
          },
        ],
      });

      const c = createMockContext({
        body: { email: 'newuser@example.com' },
        headers: { origin: 'https://example.com' },
        db,
      });

      const response = await passkeyRegisterOptionsHandler(c);
      const body = (await response.json()) as {
        error: string;
        missing_required_fields?: Array<{
          field_key: string;
          label: string;
          field_type: string;
        }>;
      };

      expect(response.status).toBe(400);
      expect(body.error).toBe('invalid_request');
      expect(body.missing_required_fields).toEqual([
        {
          field_key: 'department',
          label: 'Department',
          field_type: 'string',
        },
      ]);
    });

    it('should reject public passkey registration for an existing user', async () => {
      mockUserPIIRepository.findByTenantAndEmail.mockResolvedValueOnce({
        id: 'existing-user-id',
        email: 'existing@example.com',
        name: 'Existing User',
      });
      mockUserCoreRepository.findById.mockResolvedValueOnce({
        id: 'existing-user-id',
        is_active: true,
      });

      const c = createMockContext({
        body: { email: 'existing@example.com' },
        headers: { origin: 'https://example.com' },
      });

      const response = await passkeyRegisterOptionsHandler(c);

      expect(response.status).toBe(409);
      expect(mockUserCoreRepository.createUser).not.toHaveBeenCalled();
      expect(mockWebAuthnFunctions.generateRegistrationOptions).not.toHaveBeenCalled();
    });

    it('should store challenge in ChallengeStore', async () => {
      mockUserPIIRepository.findByTenantAndEmail.mockResolvedValueOnce(null);

      const c = createMockContext({
        body: { email: 'test@example.com' },
        headers: { origin: 'https://example.com' },
      });

      await passkeyRegisterOptionsHandler(c);

      // Verify challenge was stored via RPC (using global mock)
      expect(mockChallengeStoreStub.storeChallengeRpc).toHaveBeenCalled();
    });

    it('should reject caller-supplied userId on public passkey registration', async () => {
      const c = createMockContext({
        body: { email: 'test@example.com', userId: 'user-123' },
        headers: { origin: 'https://example.com' },
      });

      const response = await passkeyRegisterOptionsHandler(c);

      expect(response.status).toBe(401);
      expect(mockPasskeyRepository.findByUserId).not.toHaveBeenCalled();
    });
  });

  describe('passkeyLoginOptionsHandler', () => {
    it('should generate authentication options', async () => {
      const c = createMockContext({
        body: {},
        headers: { origin: 'https://example.com' },
      });

      await passkeyLoginOptionsHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            challenge: expect.any(String),
          }),
          challengeId: expect.any(String),
        })
      );
    });

    it('should reject unauthorized origins', async () => {
      const c = createMockContext({
        body: {},
        headers: { origin: 'https://malicious.com' },
      });

      const response = await passkeyLoginOptionsHandler(c);

      expect(response.status).toBe(403);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe('access_denied');
    });

    it('should allow same-origin login requests even when not listed in allowed origins', async () => {
      const c = createMockContext({
        body: {},
        headers: {
          host: 'first.multi-tenant.authrim.com',
          origin: 'https://first.multi-tenant.authrim.com',
        },
      });

      c.env.ALLOWED_ORIGINS = 'https://admin.multi-tenant.authrim.com';

      const response = await passkeyLoginOptionsHandler(c);

      expect(response.status).toBe(200);
      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            challenge: expect.any(String),
          }),
          challengeId: expect.any(String),
        })
      );
    });

    it('should ignore email and use discoverable credential login', async () => {
      mockUserPIIRepository.findByTenantAndEmail.mockResolvedValueOnce({
        id: 'user-123',
        email: 'user@example.com',
      });
      mockUserCoreRepository.findById.mockResolvedValueOnce({
        id: 'user-123',
        is_active: true,
      });
      mockPasskeyRepository.findByUserId.mockResolvedValueOnce([
        { credential_id: 'cred-1', transports: ['internal'] },
        { credential_id: 'cred-2', transports: ['usb'] },
      ]);

      const c = createMockContext({
        body: { email: 'user@example.com' },
        headers: { origin: 'https://example.com' },
      });

      await passkeyLoginOptionsHandler(c);

      expect(mockUserPIIRepository.findByTenantAndEmail).not.toHaveBeenCalled();
      expect(mockPasskeyRepository.findByUserId).not.toHaveBeenCalled();
      expect(mockWebAuthnFunctions.generateAuthenticationOptions).toHaveBeenCalledWith(
        expect.objectContaining({
          allowCredentials: [],
          userVerification: 'required',
        })
      );
    });

    it('should work without email (discoverable credential flow)', async () => {
      const c = createMockContext({
        body: {},
        headers: { origin: 'https://example.com' },
      });

      await passkeyLoginOptionsHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.any(Object),
          challengeId: expect.any(String),
        })
      );
    });

    it('should not require a JSON body for discoverable credential login', async () => {
      const c = createMockContext({
        headers: { origin: 'https://example.com' },
      });
      c.req.json.mockRejectedValueOnce(new Error('empty body'));

      const response = await passkeyLoginOptionsHandler(c);

      expect(response.status).toBe(200);
      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            challenge: expect.any(String),
          }),
          challengeId: expect.any(String),
        })
      );
    });

    it('should store challenge for later verification', async () => {
      const c = createMockContext({
        body: {},
        headers: { origin: 'https://example.com' },
      });

      await passkeyLoginOptionsHandler(c);

      // Verify challenge was stored via RPC (using global mock)
      expect(mockChallengeStoreStub.storeChallengeRpc).toHaveBeenCalled();
    });
  });

  describe('passkeyRegisterVerifyHandler', () => {
    it('should require userId in request body', async () => {
      const c = createMockContext({
        body: {
          credential: { id: 'cred-id', response: {} },
        },
        headers: { origin: 'https://example.com' },
      });

      const response = await passkeyRegisterVerifyHandler(c);

      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe('invalid_request');
    });

    it('should require credential in request body', async () => {
      const c = createMockContext({
        body: {
          userId: 'user-123',
        },
        headers: { origin: 'https://example.com' },
      });

      const response = await passkeyRegisterVerifyHandler(c);

      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe('invalid_request');
    });

    it('should verify registration and create session on success', async () => {
      const sessionStore = createMockSessionStore();
      const db = createMockDB({
        allResults: [
          {
            field_key: 'department',
            display_label: 'Department',
            field_type: 'string',
            registration_required: 0,
            validation_rules: null,
          },
        ],
      });

      mockChallengeStoreStub.consumeChallengeRpc.mockResolvedValueOnce({
        challenge: 'mock-challenge-base64',
        userId: 'user-123',
        metadata: {
          custom_fields: {
            department: 'Platform',
          },
        },
      });

      // Setup: User found after registration via Repository
      mockUserCoreRepository.findById.mockResolvedValue({
        id: 'user-123',
        is_active: true,
        email_verified: false,
        created_at: Date.now(),
        updated_at: Date.now(),
        last_login_at: Date.now(),
      });
      mockUserPIIRepository.findById.mockResolvedValue({
        id: 'user-123',
        email: 'test@example.com',
        name: 'Test User',
      });

      const c = createMockContext({
        body: {
          userId: 'user-123',
          credential: {
            id: 'mock-cred-id',
            rawId: 'mock-raw-id',
            type: 'public-key',
            response: {
              clientDataJSON: 'mock-client-data',
              attestationObject: 'mock-attestation',
            },
          },
        },
        headers: { origin: 'https://example.com' },
        sessionStore,
        db,
      });

      await passkeyRegisterVerifyHandler(c);

      // Should create passkey via Repository
      expect(mockPasskeyRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          user_id: 'user-123',
          credential_id: expect.any(String),
          public_key: expect.any(String),
          aaguid: '00000000-0000-0000-0000-000000000000',
        })
      );
      expect(db.prepare).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO user_custom_fields')
      );
      expect(mockUserCoreRepository.updateLastLogin).toHaveBeenCalledWith('user-123');
      expect(mockCoreAdapter.execute).not.toHaveBeenCalled();
    });

    it('rejects a consumed or expired registration challenge before WebAuthn verification', async () => {
      mockChallengeStoreStub.consumeChallengeRpc.mockRejectedValueOnce(new Error('consumed'));
      const c = createMockContext({
        body: {
          userId: 'user-123',
          credential: { id: 'credential-1', response: {} },
        },
        headers: { origin: 'https://example.com' },
      });

      const response = await passkeyRegisterVerifyHandler(c);

      expect(response.status).toBe(401);
      expect(mockWebAuthnFunctions.verifyRegistrationResponse).not.toHaveBeenCalled();
    });

    it('rejects a registration challenge bound to another user', async () => {
      mockChallengeStoreStub.consumeChallengeRpc.mockResolvedValueOnce({
        challenge: 'challenge',
        userId: 'other-user',
      });
      const c = createMockContext({
        body: {
          userId: 'user-123',
          credential: { id: 'credential-1', response: {} },
        },
        headers: { origin: 'https://example.com' },
      });

      const response = await passkeyRegisterVerifyHandler(c);

      expect(response.status).toBe(401);
      expect(mockWebAuthnFunctions.verifyRegistrationResponse).not.toHaveBeenCalled();
    });

    it('rejects an unauthorized registration origin after atomically consuming the challenge', async () => {
      const c = createMockContext({
        body: {
          userId: 'user-123',
          credential: { id: 'credential-1', response: {} },
        },
        headers: { origin: 'https://evil.example.com' },
      });

      const response = await passkeyRegisterVerifyHandler(c);

      expect(response.status).toBe(403);
      expect(mockChallengeStoreStub.consumeChallengeRpc).toHaveBeenCalledTimes(1);
      expect(mockWebAuthnFunctions.verifyRegistrationResponse).not.toHaveBeenCalled();
    });

    it('maps WebAuthn registration exceptions to the generic passkey error', async () => {
      mockWebAuthnFunctions.verifyRegistrationResponse.mockRejectedValueOnce(
        new Error('attestation internals')
      );
      const c = createMockContext({
        body: {
          userId: 'user-123',
          credential: { id: 'credential-1', response: {} },
        },
        headers: { origin: 'https://example.com' },
      });

      const response = await passkeyRegisterVerifyHandler(c);

      expect(response.status).toBe(400);
      expect(await response.text()).not.toContain('attestation internals');
      expect(mockPasskeyRepository.create).not.toHaveBeenCalled();
    });

    it.each([
      { verified: false },
      { verified: true, registrationInfo: undefined },
      { verified: true, registrationInfo: { counter: 0 } },
    ])('rejects incomplete WebAuthn registration results: %j', async (verification) => {
      mockWebAuthnFunctions.verifyRegistrationResponse.mockResolvedValueOnce(verification);
      const c = createMockContext({
        body: {
          userId: 'user-123',
          credential: { id: 'credential-1', response: {} },
        },
        headers: { origin: 'https://example.com' },
      });

      const response = await passkeyRegisterVerifyHandler(c);

      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(mockSessionStoreStub.createSessionRpc).not.toHaveBeenCalled();
      expect(mockPasskeyRepository.create).not.toHaveBeenCalled();
    });

    it('accepts the current nested SimpleWebAuthn registration result format', async () => {
      mockWebAuthnFunctions.verifyRegistrationResponse.mockResolvedValueOnce({
        verified: true,
        registrationInfo: {
          credential: {
            id: new Uint8Array([9, 8, 7]),
            publicKey: new Uint8Array([1, 2, 3]),
            counter: 7,
          },
        },
      });
      mockUserCoreRepository.findById.mockResolvedValue({
        id: 'user-123',
        is_active: true,
        email_verified: false,
        created_at: Date.now(),
        updated_at: Date.now(),
      });
      mockUserPIIRepository.findById.mockResolvedValue({
        id: 'user-123',
        email: 'user@example.com',
        name: 'User',
      });
      const c = createMockContext({
        body: {
          userId: 'user-123',
          credential: { id: 'credential-1', response: { transports: [] } },
        },
        headers: { origin: 'https://example.com' },
      });

      const response = await passkeyRegisterVerifyHandler(c);

      expect(response.status).toBe(200);
      expect(mockPasskeyRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ counter: 7, device_name: 'Unknown Device', aaguid: null })
      );
    });

    it('does not persist a passkey if sharded session creation fails', async () => {
      mockSessionStoreStub.createSessionRpc.mockRejectedValueOnce(new Error('DO unavailable'));
      const c = createMockContext({
        body: {
          userId: 'user-123',
          credential: { id: 'credential-1', response: {} },
        },
        headers: { origin: 'https://example.com' },
      });

      const response = await passkeyRegisterVerifyHandler(c);

      expect(response.status).toBe(500);
      expect(mockPasskeyRepository.create).not.toHaveBeenCalled();
    });
  });

  describe('passkeyLoginVerifyHandler', () => {
    it('should require challengeId in request body', async () => {
      const c = createMockContext({
        body: {
          credential: { id: 'cred-id', response: {} },
        },
        headers: { origin: 'https://example.com' },
      });

      const response = await passkeyLoginVerifyHandler(c);

      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe('invalid_request');
    });

    it('should require credential in request body', async () => {
      const c = createMockContext({
        body: {
          challengeId: 'challenge-123',
        },
        headers: { origin: 'https://example.com' },
      });

      const response = await passkeyLoginVerifyHandler(c);

      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe('invalid_request');
    });

    it('should update counter on successful authentication', async () => {
      const challengeStore = createMockChallengeStore();
      const sessionStore = createMockSessionStore();

      // Pre-store a challenge (will be consumed via /challenge/consume)
      challengeStore._challenges.set('passkey_auth:challenge-123', {
        id: 'passkey_auth:challenge-123',
        type: 'passkey_authentication',
        challenge: 'mock-auth-challenge-base64',
      });

      // Setup: Passkey found via Repository
      mockPasskeyRepository.findByCredentialId.mockResolvedValue({
        id: 'passkey-1',
        user_id: 'user-123',
        credential_id: 'mock-cred-id',
        public_key: 'YmFzZTY0LXB1YmxpYy1rZXk=', // Valid base64 encoded public key
        counter: 0,
        transports: ['internal'],
      });

      // Setup: User found via Repository
      mockUserCoreRepository.findById.mockResolvedValue({
        id: 'user-123',
        is_active: true,
        email_verified: true,
        created_at: Date.now(),
        updated_at: Date.now(),
        last_login_at: Date.now(),
      });
      mockUserPIIRepository.findById.mockResolvedValue({
        id: 'user-123',
        email: 'test@example.com',
        name: 'Test User',
      });

      const c = createMockContext({
        body: {
          challengeId: 'challenge-123',
          credential: {
            id: 'mock-cred-id',
            rawId: 'mock-raw-id',
            type: 'public-key',
            response: {
              clientDataJSON: 'mock-client-data',
              authenticatorData: 'mock-auth-data',
              signature: 'mock-signature',
            },
          },
        },
        headers: { origin: 'https://example.com' },
        challengeStore,
        sessionStore,
      });

      await passkeyLoginVerifyHandler(c);

      // The DO accepts the counter before the D1 mirror is scheduled.
      expect(mockAccountAuthStateStub.advancePasskeyCounterRpc).toHaveBeenCalledWith(
        'default',
        'user-123',
        'account:user-123',
        'passkey-1',
        0,
        1,
        expect.any(Number)
      );
      expect(mockPasskeyRepository.mirrorCounterAfterAuth).toHaveBeenCalledWith('passkey-1', 1);
    });

    it('rejects a consumed authentication challenge before credential lookup', async () => {
      mockChallengeStoreStub.consumeChallengeRpc.mockRejectedValueOnce(new Error('consumed'));
      const c = createMockContext({
        body: {
          challengeId: 'challenge-1',
          credential: { id: 'credential-1', response: {} },
        },
        headers: { origin: 'https://example.com' },
      });

      const response = await passkeyLoginVerifyHandler(c);

      expect(response.status).toBe(401);
      expect(mockPasskeyRepository.findByCredentialId).not.toHaveBeenCalled();
    });

    it('uses the legacy base64 credential ID once and migrates it to base64url', async () => {
      const passkey = {
        id: 'passkey-1',
        user_id: 'user-123',
        credential_id: 'legacy-base64',
        public_key: 'AQID',
        counter: 0,
        transports: [],
      };
      mockPasskeyRepository.findByCredentialId
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(passkey);
      mockIsoBase64URL.toBase64.mockReturnValueOnce('legacy-base64');
      mockUserCoreRepository.findById.mockResolvedValue({
        id: 'user-123',
        is_active: true,
        email_verified: true,
        created_at: Date.now(),
        updated_at: Date.now(),
      });
      mockUserPIIRepository.findById.mockResolvedValue({
        id: 'user-123',
        email: 'user@example.com',
        name: 'User',
      });
      const c = createMockContext({
        body: {
          challengeId: 'challenge-1',
          credential: { id: 'credential-url', response: {} },
        },
        headers: { origin: 'https://example.com' },
      });

      const response = await passkeyLoginVerifyHandler(c);

      expect(response.status).toBe(200);
      expect(mockCoreAdapter.execute).toHaveBeenCalledWith(
        'UPDATE passkeys SET credential_id = ? WHERE id = ? AND tenant_id = ?',
        ['credential-url', 'passkey-1', 'default']
      );
      expect(passkey.credential_id).toBe('credential-url');
    });

    it('returns the same generic error for an unknown credential', async () => {
      mockPasskeyRepository.findByCredentialId.mockResolvedValue(null);
      const c = createMockContext({
        body: {
          challengeId: 'challenge-1',
          credential: { id: 'unknown-credential', response: {} },
        },
        headers: { origin: 'https://example.com' },
      });

      const response = await passkeyLoginVerifyHandler(c);

      expect(response.status).toBe(400);
      expect(mockWebAuthnFunctions.verifyAuthenticationResponse).not.toHaveBeenCalled();
    });

    it('rejects an unauthorized login origin before WebAuthn verification', async () => {
      mockPasskeyRepository.findByCredentialId.mockResolvedValueOnce({
        id: 'passkey-1',
        user_id: 'user-123',
        credential_id: 'credential-1',
        public_key: 'AQID',
        counter: 0,
        transports: [],
      });
      const c = createMockContext({
        body: {
          challengeId: 'challenge-1',
          credential: { id: 'credential-1', response: {} },
        },
        headers: { origin: 'https://evil.example.com' },
      });

      const response = await passkeyLoginVerifyHandler(c);

      expect(response.status).toBe(403);
      expect(mockWebAuthnFunctions.verifyAuthenticationResponse).not.toHaveBeenCalled();
    });

    it.each([
      ['verification exception', new Error('signature detail')],
      ['unverified response', { verified: false }],
    ])('fails closed for %s', async (_label, outcome) => {
      mockPasskeyRepository.findByCredentialId.mockResolvedValueOnce({
        id: 'passkey-1',
        user_id: 'user-123',
        credential_id: 'credential-1',
        public_key: 'AQID',
        counter: 0,
        transports: [],
      });
      if (outcome instanceof Error) {
        mockWebAuthnFunctions.verifyAuthenticationResponse.mockRejectedValueOnce(outcome);
      } else {
        mockWebAuthnFunctions.verifyAuthenticationResponse.mockResolvedValueOnce(outcome);
      }
      const c = createMockContext({
        body: {
          challengeId: 'challenge-1',
          credential: { id: 'credential-1', response: {} },
        },
        headers: { origin: 'https://example.com' },
      });

      const response = await passkeyLoginVerifyHandler(c);

      expect(response.status).toBe(400);
      expect(mockSessionStoreStub.createSessionRpc).not.toHaveBeenCalled();
      expect(mockPasskeyRepository.updateCounterAfterAuth).not.toHaveBeenCalled();
    });

    it('rejects a valid credential belonging to an inactive user', async () => {
      mockPasskeyRepository.findByCredentialId.mockResolvedValueOnce({
        id: 'passkey-1',
        user_id: 'inactive-user',
        credential_id: 'credential-1',
        public_key: 'AQID',
        counter: 0,
        transports: [],
      });
      mockUserCoreRepository.findById.mockResolvedValueOnce({
        id: 'inactive-user',
        is_active: false,
      });
      const c = createMockContext({
        body: {
          challengeId: 'challenge-1',
          credential: { id: 'credential-1', response: {} },
        },
        headers: { origin: 'https://example.com' },
      });

      const response = await passkeyLoginVerifyHandler(c);

      expect(response.status).toBe(400);
      expect(mockSessionStoreStub.createSessionRpc).not.toHaveBeenCalled();
    });

    it('does not mirror the accepted authenticator counter if session creation fails', async () => {
      mockPasskeyRepository.findByCredentialId.mockResolvedValueOnce({
        id: 'passkey-1',
        user_id: 'user-123',
        credential_id: 'credential-1',
        public_key: 'AQID',
        counter: 3,
        transports: [],
      });
      mockUserCoreRepository.findById.mockResolvedValue({
        id: 'user-123',
        is_active: true,
        email_verified: true,
        created_at: Date.now(),
        updated_at: Date.now(),
      });
      mockUserPIIRepository.findById.mockResolvedValue({
        id: 'user-123',
        email: 'user@example.com',
        name: 'User',
      });
      mockSessionStoreStub.createSessionRpc.mockRejectedValueOnce(new Error('DO unavailable'));
      const c = createMockContext({
        body: {
          challengeId: 'challenge-1',
          credential: { id: 'credential-1', response: {} },
        },
        headers: { origin: 'https://example.com' },
      });

      const response = await passkeyLoginVerifyHandler(c);

      expect(response.status).toBe(500);
      expect(mockAccountAuthStateStub.advancePasskeyCounterRpc).toHaveBeenCalledOnce();
      expect(mockPasskeyRepository.mirrorCounterAfterAuth).not.toHaveBeenCalled();
    });
  });
});
