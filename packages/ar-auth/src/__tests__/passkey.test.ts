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

// Mock @authrim/ar-lib-core module
vi.mock('@authrim/ar-lib-core', async () => {
  const actual = await vi.importActual('@authrim/ar-lib-core');
  return {
    ...actual,
    getSessionStoreForNewSession: () =>
      Promise.resolve({
        stub: mockSessionStoreStub,
        sessionId: 'mock-session-id',
      }),
    getChallengeStoreByUserId: () => Promise.resolve(mockChallengeStoreStub),
    getChallengeStoreByChallengeId: () => Promise.resolve(mockChallengeStoreStub),
    // Repository pattern mocks - return the pre-defined context objects
    createAuthContextFromHono: () => mockAuthContext,
    createPIIContextFromHono: () => mockPIIContext,
    getTenantIdFromContext: () => 'default',
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
    } as unknown as Env,
    json: vi.fn((body, status = 200) => new Response(JSON.stringify(body), { status })),
    get: vi.fn((key: string) => contextStore.get(key)),
    set: vi.fn((key: string, value: unknown) => contextStore.set(key, value)),
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
    mockCoreAdapter.execute.mockReset().mockResolvedValue({ rowsAffected: 1 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('passkeyRegisterOptionsHandler', () => {
    it('should require email parameter', async () => {
      const c = createMockContext({
        body: {},
        headers: { origin: 'https://example.com' },
      });

      const response = await passkeyRegisterOptionsHandler(c);

      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string; error_description?: string };
      expect(body.error).toBe('invalid_request');
      // AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD returns generic message
      expect(body.error_description).toContain('required');
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

    it('should generate registration options for existing user', async () => {
      // PII/Non-PII DB Separation via Repository:
      // 1. Query PII DB for user by email
      // 2. Query Core DB to verify user exists and is active
      // 3. Query for existing passkeys via Repository

      // Setup: User found in PII DB
      mockUserPIIRepository.findByTenantAndEmail.mockResolvedValueOnce({
        id: 'existing-user-id',
        email: 'existing@example.com',
        name: 'Existing User',
      });

      // Setup: User is active in Core DB
      mockUserCoreRepository.findById.mockResolvedValueOnce({
        id: 'existing-user-id',
        is_active: true,
      });

      const c = createMockContext({
        body: { email: 'existing@example.com' },
        headers: { origin: 'https://example.com' },
      });

      await passkeyRegisterOptionsHandler(c);

      // Should not create new user via Repository
      expect(mockUserCoreRepository.createUser).not.toHaveBeenCalled();
      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            challenge: expect.any(String),
          }),
          userId: 'existing-user-id',
        })
      );
    });

    it('should store challenge in ChallengeStore', async () => {
      // Setup: User found in PII DB and Core DB
      mockUserPIIRepository.findByTenantAndEmail.mockResolvedValueOnce({
        id: 'user-123',
        email: 'test@example.com',
        name: 'Test',
      });
      mockUserCoreRepository.findById.mockResolvedValueOnce({
        id: 'user-123',
        is_active: true,
      });

      const c = createMockContext({
        body: { email: 'test@example.com' },
        headers: { origin: 'https://example.com' },
      });

      await passkeyRegisterOptionsHandler(c);

      // Verify challenge was stored via RPC (using global mock)
      expect(mockChallengeStoreStub.storeChallengeRpc).toHaveBeenCalled();
    });

    it('should include existing passkeys as excludeCredentials', async () => {
      // Setup: User found in PII DB and Core DB with existing passkeys
      mockUserPIIRepository.findByTenantAndEmail.mockResolvedValueOnce({
        id: 'user-123',
        email: 'test@example.com',
        name: 'Test',
      });
      mockUserCoreRepository.findById.mockResolvedValueOnce({
        id: 'user-123',
        is_active: true,
      });
      mockPasskeyRepository.findByUserId.mockResolvedValueOnce([
        { credential_id: 'existing-cred-1', transports: ['internal'] },
        { credential_id: 'existing-cred-2', transports: ['usb'] },
      ]);

      const c = createMockContext({
        body: { email: 'test@example.com' },
        headers: { origin: 'https://example.com' },
      });

      await passkeyRegisterOptionsHandler(c);

      // Should query for existing passkeys via Repository
      expect(mockPasskeyRepository.findByUserId).toHaveBeenCalledWith('user-123');
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

    it('should include user credentials when email provided', async () => {
      // PII/Non-PII DB Separation via Repository pattern:
      // 1. Query PII DB for user by email
      // 2. Query Core DB to verify user exists and is active
      // 3. Query for user's passkeys via Repository

      // Setup: User found in PII DB
      mockUserPIIRepository.findByTenantAndEmail.mockResolvedValueOnce({
        id: 'user-123',
        email: 'user@example.com',
      });

      // Setup: User is active in Core DB
      mockUserCoreRepository.findById.mockResolvedValueOnce({
        id: 'user-123',
        is_active: true,
      });

      // Setup: User has existing passkeys
      mockPasskeyRepository.findByUserId.mockResolvedValueOnce([
        { credential_id: 'cred-1', transports: ['internal'] },
        { credential_id: 'cred-2', transports: ['usb'] },
      ]);

      const c = createMockContext({
        body: { email: 'user@example.com' },
        headers: { origin: 'https://example.com' },
      });

      await passkeyLoginOptionsHandler(c);

      // Should query PII DB for user by email via Repository
      expect(mockUserPIIRepository.findByTenantAndEmail).toHaveBeenCalledWith(
        'default',
        'user@example.com'
      );
      // Should query for passkeys via Repository
      expect(mockPasskeyRepository.findByUserId).toHaveBeenCalledWith('user-123');
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
      const challengeStore = createMockChallengeStore();
      const sessionStore = createMockSessionStore();

      // Pre-store a challenge (will be consumed via /challenge/consume)
      challengeStore._challenges.set('passkey_reg:user-123', {
        id: 'passkey_reg:user-123',
        type: 'passkey_registration',
        userId: 'user-123',
        challenge: 'mock-challenge-base64',
        email: 'test@example.com',
      });

      // Setup: User found after registration via Repository
      mockUserCoreRepository.findById.mockResolvedValue({
        id: 'user-123',
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
        challengeStore,
        sessionStore,
      });

      await passkeyRegisterVerifyHandler(c);

      // Should create passkey via Repository
      expect(mockPasskeyRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          user_id: 'user-123',
          credential_id: expect.any(String),
          public_key: expect.any(String),
        })
      );
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

      // Should update counter via Repository
      expect(mockPasskeyRepository.updateCounterAfterAuth).toHaveBeenCalledWith(
        'passkey-1',
        1 // newCounter from verifyAuthenticationResponse mock
      );
    });
  });
});
