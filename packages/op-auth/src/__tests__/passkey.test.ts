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
import type { Env } from '@authrim/shared/types/env';
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

// Mock @simplewebauthn/server
vi.mock('@simplewebauthn/server', () => mockWebAuthnFunctions);

// Mock @simplewebauthn/server/helpers
vi.mock('@simplewebauthn/server/helpers', () => ({
  isoBase64URL: mockIsoBase64URL,
}));

// Mock session store stub for RPC pattern
const mockSessionStoreStub = {
  createSessionRpc: vi.fn().mockResolvedValue({
    id: 'mock-session-id',
    userId: 'user-123',
    authTime: Date.now(),
    amr: ['passkey'],
  }),
};

// Mock @authrim/shared module
vi.mock('@authrim/shared', async () => {
  const actual = await vi.importActual('@authrim/shared');
  return {
    ...actual,
    getSessionStoreForNewSession: vi.fn(() =>
      Promise.resolve({
        stub: mockSessionStoreStub,
        sessionId: 'mock-session-id',
      })
    ),
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
  challengeStore?: ReturnType<typeof createMockChallengeStore>;
  sessionStore?: ReturnType<typeof createMockSessionStore>;
}) {
  const mockDB =
    options.db ??
    createMockDB({
      firstResult: null,
      allResults: [],
    });

  const challengeStore = options.challengeStore ?? createMockChallengeStore();
  const sessionStore = options.sessionStore ?? createMockSessionStore();

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
      ISSUER_URL: 'https://example.com',
      ALLOWED_ORIGINS: 'https://example.com',
      CHALLENGE_STORE: challengeStore,
      SESSION_STORE: sessionStore,
    } as unknown as Env,
    json: vi.fn((body, status = 200) => new Response(JSON.stringify(body), { status })),
    _mockDB: mockDB,
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

    // Setup isoBase64URL mock implementations
    mockIsoBase64URL.isBase64URL.mockReturnValue(true);
    mockIsoBase64URL.isBase64.mockReturnValue(false);
    mockIsoBase64URL.trimPadding.mockImplementation((input: string) => input);
    mockIsoBase64URL.fromBuffer.mockImplementation(() => 'mock-base64url-string');
    mockIsoBase64URL.toBuffer.mockImplementation(() => new Uint8Array([1, 2, 3, 4]));
    mockIsoBase64URL.toBase64.mockImplementation((input: string) => input);
    mockIsoBase64URL.fromUTF8String.mockImplementation((input: string) => input);
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

      await passkeyRegisterOptionsHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_request',
          error_description: 'Email is required',
        }),
        400
      );
    });

    it('should reject unauthorized origins', async () => {
      const c = createMockContext({
        body: { email: 'test@example.com' },
        headers: { origin: 'https://malicious.com' },
      });

      await passkeyRegisterOptionsHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'unauthorized_origin',
        }),
        403
      );
    });

    it('should reject requests without origin header', async () => {
      const c = createMockContext({
        body: { email: 'test@example.com' },
        headers: {},
      });

      await passkeyRegisterOptionsHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'unauthorized_origin',
        }),
        403
      );
    });

    it('should generate registration options for new user', async () => {
      const mockDB = createMockDB({
        firstResult: null, // User doesn't exist
        runResult: { success: true },
        allResults: [], // No existing passkeys
      });

      const c = createMockContext({
        body: { email: 'newuser@example.com' },
        headers: { origin: 'https://example.com' },
        db: mockDB,
      });

      await passkeyRegisterOptionsHandler(c);

      // Should create new user and return options
      expect(mockDB.prepare).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO users'));
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
      const mockDB = createMockDB({
        firstResult: {
          id: 'existing-user-id',
          email: 'existing@example.com',
          name: 'Existing User',
        },
        allResults: [], // No existing passkeys
      });

      const c = createMockContext({
        body: { email: 'existing@example.com' },
        headers: { origin: 'https://example.com' },
        db: mockDB,
      });

      await passkeyRegisterOptionsHandler(c);

      // Should not create new user
      expect(mockDB.prepare).not.toHaveBeenCalledWith(expect.stringContaining('INSERT INTO users'));
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
      const challengeStore = createMockChallengeStore();
      const mockDB = createMockDB({
        firstResult: { id: 'user-123', email: 'test@example.com', name: 'Test' },
        allResults: [],
      });

      const c = createMockContext({
        body: { email: 'test@example.com' },
        headers: { origin: 'https://example.com' },
        db: mockDB,
        challengeStore,
      });

      await passkeyRegisterOptionsHandler(c);

      // Verify challenge was stored
      expect(challengeStore.get().fetch).toHaveBeenCalled();
    });

    it('should include existing passkeys as excludeCredentials', async () => {
      const mockDB = createMockDB({
        firstResult: { id: 'user-123', email: 'test@example.com', name: 'Test' },
        allResults: [
          { credential_id: 'existing-cred-1', transports: '["internal"]' },
          { credential_id: 'existing-cred-2', transports: '["usb"]' },
        ],
      });

      const c = createMockContext({
        body: { email: 'test@example.com' },
        headers: { origin: 'https://example.com' },
        db: mockDB,
      });

      await passkeyRegisterOptionsHandler(c);

      // Should query for existing passkeys
      expect(mockDB.prepare).toHaveBeenCalledWith(
        expect.stringContaining('SELECT credential_id, transports FROM passkeys')
      );
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

      await passkeyLoginOptionsHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'unauthorized_origin',
        }),
        403
      );
    });

    it('should include user credentials when email provided', async () => {
      const mockDB = createMockDB({
        firstResult: { id: 'user-123' },
        allResults: [
          { credential_id: 'cred-1', transports: '["internal"]' },
          { credential_id: 'cred-2', transports: '["usb"]' },
        ],
      });

      const c = createMockContext({
        body: { email: 'user@example.com' },
        headers: { origin: 'https://example.com' },
        db: mockDB,
      });

      await passkeyLoginOptionsHandler(c);

      // Should query for user and their passkeys
      expect(mockDB.prepare).toHaveBeenCalledWith(
        expect.stringContaining('SELECT id FROM users WHERE email')
      );
      expect(mockDB.prepare).toHaveBeenCalledWith(
        expect.stringContaining('SELECT credential_id, transports FROM passkeys')
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

    it('should store challenge for later verification', async () => {
      const challengeStore = createMockChallengeStore();

      const c = createMockContext({
        body: {},
        headers: { origin: 'https://example.com' },
        challengeStore,
      });

      await passkeyLoginOptionsHandler(c);

      expect(challengeStore.get().fetch).toHaveBeenCalled();
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

      await passkeyRegisterVerifyHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_request',
        }),
        400
      );
    });

    it('should require credential in request body', async () => {
      const c = createMockContext({
        body: {
          userId: 'user-123',
        },
        headers: { origin: 'https://example.com' },
      });

      await passkeyRegisterVerifyHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_request',
        }),
        400
      );
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

      const mockDB = createMockDB({
        firstResult: { id: 'user-123', email: 'test@example.com' },
        runResult: { success: true },
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
        db: mockDB,
        challengeStore,
        sessionStore,
      });

      await passkeyRegisterVerifyHandler(c);

      // Should insert passkey into database
      expect(mockDB.prepare).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO passkeys'));
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

      await passkeyLoginVerifyHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_request',
        }),
        400
      );
    });

    it('should require credential in request body', async () => {
      const c = createMockContext({
        body: {
          challengeId: 'challenge-123',
        },
        headers: { origin: 'https://example.com' },
      });

      await passkeyLoginVerifyHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_request',
        }),
        400
      );
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

      const mockDB = createMockDB({
        firstResult: {
          id: 'passkey-1',
          user_id: 'user-123',
          credential_id: 'mock-cred-id',
          public_key: 'YmFzZTY0LXB1YmxpYy1rZXk=', // Valid base64 encoded public key
          counter: 0,
        },
        runResult: { success: true },
      });

      // Make subsequent first() calls return appropriate data
      let callCount = 0;
      (mockDB as any)._mockStatement.first.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          // First call: SELECT passkey by credential_id
          return Promise.resolve({
            id: 'passkey-1',
            user_id: 'user-123',
            credential_id: 'mock-cred-id',
            public_key: 'YmFzZTY0LXB1YmxpYy1rZXk=',
            counter: 0,
          });
        }
        // Subsequent calls: SELECT user by id
        return Promise.resolve({
          id: 'user-123',
          email: 'test@example.com',
          name: 'Test User',
          email_verified: 1,
          created_at: Date.now(),
          updated_at: Date.now(),
          last_login_at: Date.now(),
        });
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
        db: mockDB,
        challengeStore,
        sessionStore,
      });

      await passkeyLoginVerifyHandler(c);

      // Should update counter
      expect(mockDB.prepare).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE passkeys SET counter')
      );
    });
  });
});
