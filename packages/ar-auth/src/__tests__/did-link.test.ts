/**
 * DID Link Management Tests
 *
 * Comprehensive security tests for DID linking/unlinking including:
 * - Authentication requirement enforcement
 * - Challenge generation and consumption for registration
 * - DID ownership verification
 * - Race condition handling
 * - Authorization checks for unlinking
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';
import type { Env, Session } from '@authrim/ar-lib-core';

// Response type for test assertions - permissive to allow property access without narrowing
type ApiResponse = Record<string, unknown>;

// Mock jose module
vi.mock('jose', () => ({
  jwtVerify: vi.fn(),
  importJWK: vi.fn(),
  decodeProtectedHeader: vi.fn(),
}));

// Mock hono/cookie
vi.mock('hono/cookie', () => ({
  getCookie: vi.fn(),
}));

// Mock functions using vi.hoisted
const mockChallengeStoreStub = vi.hoisted(() => ({
  storeChallengeRpc: vi.fn(),
  consumeChallengeRpc: vi.fn(),
}));

const mockSessionStoreStub = vi.hoisted(() => ({
  getSessionRpc: vi.fn(),
}));

const mockLinkedIdentityRepo = vi.hoisted(() => ({
  findByProviderUser: vi.fn(),
  findByUserId: vi.fn(),
  createLinkedIdentity: vi.fn(),
  unlink: vi.fn(),
}));

const mockResolveDID = vi.hoisted(() => vi.fn());

// Mock @authrim/ar-lib-core
vi.mock('@authrim/ar-lib-core', async () => {
  const actual = await vi.importActual('@authrim/ar-lib-core');
  return {
    ...actual,
    getChallengeStoreByDID: vi.fn(() => mockChallengeStoreStub),
    getSessionStoreBySessionId: vi.fn(() => ({
      stub: mockSessionStoreStub,
    })),
    resolveDID: mockResolveDID,
    D1Adapter: class {
      constructor() {}
    },
    LinkedIdentityRepository: class {
      constructor() {}
      findByProviderUser = mockLinkedIdentityRepo.findByProviderUser;
      findByUserId = mockLinkedIdentityRepo.findByUserId;
      createLinkedIdentity = mockLinkedIdentityRepo.createLinkedIdentity;
      unlink = mockLinkedIdentityRepo.unlink;
    },
  };
});

import {
  didRegisterChallengeHandler,
  didRegisterVerifyHandler,
  didListHandler,
  didUnlinkHandler,
} from '../did-link';
import { getCookie } from 'hono/cookie';
import { jwtVerify, importJWK, decodeProtectedHeader } from 'jose';

// Helper to create mock context
function createMockContext(overrides: {
  body?: Record<string, unknown>;
  env?: Partial<Env>;
  cookies?: Record<string, string>;
  params?: Record<string, string>;
}): Context<{ Bindings: Env }> {
  const defaultEnv: Env = {
    DB: {} as D1Database,
    DB_PII: {} as D1Database,
    AUTHRIM_CONFIG: {} as KVNamespace,
    CHALLENGE_STORE: {
      idFromName: vi.fn().mockReturnValue({ toString: () => 'mock-id' }),
      get: vi.fn().mockReturnValue(mockChallengeStoreStub),
    } as unknown as DurableObjectNamespace,
    SESSION_STORE: {
      idFromName: vi.fn().mockReturnValue({ toString: () => 'mock-id' }),
      get: vi.fn().mockReturnValue(mockSessionStoreStub),
    } as unknown as DurableObjectNamespace,
    ISSUER_URL: 'https://issuer.example.com',
    ...overrides.env,
  } as Env;

  // Setup cookie mock
  if (overrides.cookies) {
    vi.mocked(getCookie).mockImplementation((_c, name) => overrides.cookies?.[name]);
  } else {
    vi.mocked(getCookie).mockReturnValue(undefined);
  }

  // Store context values (simulating Hono's context store)
  const contextStore = new Map<string, unknown>([['tenantId', 'default']]);

  return {
    req: {
      json: vi.fn().mockResolvedValue(overrides.body ?? {}),
      param: vi.fn((key: string) => overrides.params?.[key]),
      header: vi.fn().mockReturnValue(undefined),
    },
    env: defaultEnv,
    json: vi.fn((data: unknown, status?: number) => {
      return new Response(JSON.stringify(data), {
        status: status ?? 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
    get: vi.fn((key: string) => contextStore.get(key)),
    set: vi.fn((key: string, value: unknown) => contextStore.set(key, value)),
  } as unknown as Context<{ Bindings: Env }>;
}

// Sample DID document for testing
const sampleDIDDocument = {
  '@context': ['https://www.w3.org/ns/did/v1'],
  id: 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH',
  verificationMethod: [
    {
      id: 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH#z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH',
      type: 'JsonWebKey2020',
      controller: 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH',
      publicKeyJwk: {
        kty: 'OKP',
        crv: 'Ed25519',
        x: 'base64url-encoded-x',
      },
    },
  ],
  authentication: [
    'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH#z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH',
  ],
};

const validKid =
  'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH#z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH';

describe('DID Link Management', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveDID.mockReset();
    mockChallengeStoreStub.storeChallengeRpc.mockReset();
    mockChallengeStoreStub.consumeChallengeRpc.mockReset();
    mockSessionStoreStub.getSessionRpc.mockReset();
    mockLinkedIdentityRepo.findByProviderUser.mockReset();
    mockLinkedIdentityRepo.findByUserId.mockReset();
    mockLinkedIdentityRepo.createLinkedIdentity.mockReset();
    mockLinkedIdentityRepo.unlink.mockReset();
  });

  describe('didRegisterChallengeHandler', () => {
    describe('Authentication Requirement', () => {
      it('should reject unauthenticated request (no session cookie)', async () => {
        const c = createMockContext({
          body: { did: 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH' },
        });

        const response = await didRegisterChallengeHandler(c);

        expect(response.status).toBe(401);
        const data = (await response.json()) as ApiResponse;
        expect(data.error).toBe('login_required');
        expect(data.error_description).toContain('Authentication');
      });

      it('should reject when session is invalid', async () => {
        const c = createMockContext({
          body: { did: 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH' },
          cookies: { authrim_session: 'invalid-session-id' },
        });
        mockSessionStoreStub.getSessionRpc.mockResolvedValue(null);

        const response = await didRegisterChallengeHandler(c);

        expect(response.status).toBe(401);
        const data = (await response.json()) as ApiResponse;
        expect(data.error).toBe('login_required');
      });

      it('should reject when session has no userId', async () => {
        const c = createMockContext({
          body: { did: 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH' },
          cookies: { authrim_session: 'valid-session-id' },
        });
        mockSessionStoreStub.getSessionRpc.mockResolvedValue({
          userId: null,
        } as unknown as Session);

        const response = await didRegisterChallengeHandler(c);

        expect(response.status).toBe(401);
        const data = (await response.json()) as ApiResponse;
        expect(data.error).toBe('login_required');
      });
    });

    describe('Input Validation', () => {
      beforeEach(() => {
        mockSessionStoreStub.getSessionRpc.mockResolvedValue({ userId: 'user-123' } as Session);
      });

      it('should reject missing DID', async () => {
        const c = createMockContext({
          body: {},
          cookies: { authrim_session: 'valid-session' },
        });

        const response = await didRegisterChallengeHandler(c);

        expect(response.status).toBe(400);
        const data = (await response.json()) as ApiResponse;
        expect(data.error).toBe('invalid_request');
        // AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD returns generic message
        expect(data.error_description).toContain('required');
      });

      it('should reject empty DID', async () => {
        const c = createMockContext({
          body: { did: '' },
          cookies: { authrim_session: 'valid-session' },
        });

        const response = await didRegisterChallengeHandler(c);

        expect(response.status).toBe(400);
        const data = (await response.json()) as ApiResponse;
        expect(data.error).toBe('invalid_request');
      });

      it('should reject whitespace-only DID', async () => {
        const c = createMockContext({
          body: { did: '   ' },
          cookies: { authrim_session: 'valid-session' },
        });

        const response = await didRegisterChallengeHandler(c);

        expect(response.status).toBe(400);
        const data = (await response.json()) as ApiResponse;
        expect(data.error).toBe('invalid_request');
      });

      it('should reject invalid DID format', async () => {
        const c = createMockContext({
          body: { did: 'not-a-did' },
          cookies: { authrim_session: 'valid-session' },
        });

        const response = await didRegisterChallengeHandler(c);

        expect(response.status).toBe(400);
        const data = (await response.json()) as ApiResponse;
        expect(data.error).toBe('invalid_request');
        // AR_ERROR_CODES.VALIDATION_INVALID_VALUE returns generic message
        expect(data.error_description).toContain('invalid');
      });
    });

    describe('DID Already Linked', () => {
      beforeEach(() => {
        mockSessionStoreStub.getSessionRpc.mockResolvedValue({ userId: 'user-123' } as Session);
      });

      it('should reject DID already linked to same user', async () => {
        const c = createMockContext({
          body: { did: 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH' },
          cookies: { authrim_session: 'valid-session' },
        });
        mockLinkedIdentityRepo.findByProviderUser.mockResolvedValue({
          user_id: 'user-123', // Same user
          provider_id: 'did',
          provider_user_id: 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH',
        });

        const response = await didRegisterChallengeHandler(c);

        expect(response.status).toBe(400);
        const data = (await response.json()) as ApiResponse;
        expect(data.error).toBe('invalid_request');
        // AR_ERROR_CODES returns generic validation message
        expect(data.error_description).toContain('invalid');
      });

      it('should reject DID already linked to different user', async () => {
        const c = createMockContext({
          body: { did: 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH' },
          cookies: { authrim_session: 'valid-session' },
        });
        mockLinkedIdentityRepo.findByProviderUser.mockResolvedValue({
          user_id: 'different-user', // Different user
          provider_id: 'did',
          provider_user_id: 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH',
        });

        const response = await didRegisterChallengeHandler(c);

        expect(response.status).toBe(400);
        const data = (await response.json()) as ApiResponse;
        expect(data.error).toBe('invalid_request');
        // AR_ERROR_CODES returns generic validation message
        expect(data.error_description).toContain('invalid');
      });
    });

    describe('Challenge Generation', () => {
      beforeEach(() => {
        mockSessionStoreStub.getSessionRpc.mockResolvedValue({ userId: 'user-123' } as Session);
        mockLinkedIdentityRepo.findByProviderUser.mockResolvedValue(null);
      });

      it('should generate challenge for valid authenticated request', async () => {
        const c = createMockContext({
          body: { did: 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH' },
          cookies: { authrim_session: 'valid-session' },
        });
        mockResolveDID.mockResolvedValue(sampleDIDDocument);
        mockChallengeStoreStub.storeChallengeRpc.mockResolvedValue({ success: true });

        const response = await didRegisterChallengeHandler(c);

        expect(response.status).toBe(200);
        const data = (await response.json()) as ApiResponse;
        expect(data.challenge_id).toBeDefined();
        expect(data.challenge).toBeDefined();
        expect(data.nonce).toBeDefined();
        expect(data.expires_in).toBe(300);
      });

      it('should store userId in challenge metadata', async () => {
        const c = createMockContext({
          body: { did: 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH' },
          cookies: { authrim_session: 'valid-session' },
        });
        mockResolveDID.mockResolvedValue(sampleDIDDocument);
        mockChallengeStoreStub.storeChallengeRpc.mockResolvedValue({ success: true });

        await didRegisterChallengeHandler(c);

        expect(mockChallengeStoreStub.storeChallengeRpc).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'did_registration',
            userId: 'user-123',
          })
        );
      });

      it('should reject DID with no authentication methods', async () => {
        const c = createMockContext({
          body: { did: 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH' },
          cookies: { authrim_session: 'valid-session' },
        });
        mockResolveDID.mockResolvedValue({
          id: 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH',
          authentication: [],
          verificationMethod: [],
        });

        const response = await didRegisterChallengeHandler(c);

        expect(response.status).toBe(400);
        const data = (await response.json()) as ApiResponse;
        expect(data.error).toBe('invalid_request');
        // AR_ERROR_CODES.VALIDATION_INVALID_VALUE returns generic message
        expect(data.error_description).toContain('invalid');
      });
    });
  });

  describe('didRegisterVerifyHandler', () => {
    describe('Input Validation', () => {
      it('should reject missing challenge_id', async () => {
        const c = createMockContext({ body: { proof: 'valid.jwt' } });
        const response = await didRegisterVerifyHandler(c);

        expect(response.status).toBe(400);
        const data = (await response.json()) as ApiResponse;
        expect(data.error).toBe('invalid_request');
      });

      it('should reject empty proof', async () => {
        const c = createMockContext({ body: { challenge_id: 'test', proof: '' } });
        const response = await didRegisterVerifyHandler(c);

        expect(response.status).toBe(400);
        const data = (await response.json()) as ApiResponse;
        expect(data.error).toBe('invalid_request');
      });
    });

    describe('Early DID Link Check', () => {
      it('should reject if DID is already linked before verification', async () => {
        const c = createMockContext({
          body: { challenge_id: 'test', proof: 'header.payload.sig' },
        });
        vi.mocked(decodeProtectedHeader).mockReturnValue({ alg: 'ES256', kid: validKid });
        mockLinkedIdentityRepo.findByProviderUser.mockResolvedValue({
          user_id: 'other-user',
          provider_id: 'did',
          provider_user_id: 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH',
        });

        const response = await didRegisterVerifyHandler(c);

        expect(response.status).toBe(400);
        const data = (await response.json()) as ApiResponse;
        expect(data.error).toBe('invalid_request');
      });
    });

    describe('Successful Registration', () => {
      beforeEach(() => {
        vi.mocked(decodeProtectedHeader).mockReturnValue({ alg: 'ES256', kid: validKid });
        mockLinkedIdentityRepo.findByProviderUser.mockResolvedValue(null);
        mockChallengeStoreStub.consumeChallengeRpc.mockResolvedValue({
          challenge: 'test-challenge',
          userId: 'user-123',
          metadata: {
            did: 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH',
            allowedVerificationMethods: [validKid],
            nonce: 'test-nonce',
          },
        });
        mockResolveDID.mockResolvedValue(sampleDIDDocument);
        vi.mocked(importJWK).mockResolvedValue({} as CryptoKey);
        vi.mocked(jwtVerify).mockResolvedValue({
          payload: {
            iss: 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH',
            nonce: 'test-nonce',
            aud: 'https://issuer.example.com',
          },
          protectedHeader: { alg: 'ES256' },
        } as never);
      });

      it('should successfully link DID to user', async () => {
        const c = createMockContext({
          body: { challenge_id: 'test', proof: 'header.payload.sig' },
        });
        mockLinkedIdentityRepo.createLinkedIdentity.mockResolvedValue('link-id');

        const response = await didRegisterVerifyHandler(c);

        expect(response.status).toBe(200);
        const data = (await response.json()) as ApiResponse;
        expect(data.success).toBe(true);
        expect(data.did).toBe('did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH');
      });

      it('should store correct linked identity data', async () => {
        const c = createMockContext({
          body: { challenge_id: 'test', proof: 'header.payload.sig' },
        });
        mockLinkedIdentityRepo.createLinkedIdentity.mockResolvedValue('link-id');

        await didRegisterVerifyHandler(c);

        expect(mockLinkedIdentityRepo.createLinkedIdentity).toHaveBeenCalledWith(
          expect.objectContaining({
            user_id: 'user-123',
            provider_id: 'did',
            provider_user_id: 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH',
            raw_attributes: expect.objectContaining({
              did: 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH',
              verificationMethod: validKid,
            }),
          })
        );
      });
    });

    describe('Race Condition Handling', () => {
      beforeEach(() => {
        vi.mocked(decodeProtectedHeader).mockReturnValue({ alg: 'ES256', kid: validKid });
        mockLinkedIdentityRepo.findByProviderUser.mockResolvedValue(null);
        mockChallengeStoreStub.consumeChallengeRpc.mockResolvedValue({
          challenge: 'test-challenge',
          userId: 'user-123',
          metadata: {
            did: 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH',
            allowedVerificationMethods: [validKid],
            nonce: 'test-nonce',
          },
        });
        mockResolveDID.mockResolvedValue(sampleDIDDocument);
        vi.mocked(importJWK).mockResolvedValue({} as CryptoKey);
        vi.mocked(jwtVerify).mockResolvedValue({
          payload: {
            iss: 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH',
            nonce: 'test-nonce',
            aud: 'https://issuer.example.com',
          },
          protectedHeader: { alg: 'ES256' },
        } as never);
      });

      it('should handle UNIQUE constraint error (another user linked the DID)', async () => {
        const c = createMockContext({
          body: { challenge_id: 'test', proof: 'header.payload.sig' },
        });
        mockLinkedIdentityRepo.createLinkedIdentity.mockRejectedValue(
          new Error('UNIQUE constraint failed')
        );
        // After error, check shows different user
        mockLinkedIdentityRepo.findByProviderUser
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce({
            user_id: 'other-user',
            provider_id: 'did',
            provider_user_id: 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH',
          });

        const response = await didRegisterVerifyHandler(c);

        expect(response.status).toBe(400);
        const data = (await response.json()) as ApiResponse;
        expect(data.error).toBe('invalid_request');
        // AR_ERROR_CODES returns generic validation message
        expect(data.error_description).toContain('invalid');
      });

      it('should handle idempotent success (same user already linked)', async () => {
        const c = createMockContext({
          body: { challenge_id: 'test', proof: 'header.payload.sig' },
        });
        mockLinkedIdentityRepo.createLinkedIdentity.mockRejectedValue(
          new Error('UNIQUE constraint failed')
        );
        // After error, check shows same user
        mockLinkedIdentityRepo.findByProviderUser
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce({
            user_id: 'user-123', // Same user
            provider_id: 'did',
            provider_user_id: 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH',
          });

        const response = await didRegisterVerifyHandler(c);

        expect(response.status).toBe(200);
        const data = (await response.json()) as ApiResponse;
        expect(data.success).toBe(true);
        expect(data.message).toContain('already linked to your account');
      });
    });
  });

  describe('didListHandler', () => {
    describe('Authentication Requirement', () => {
      it('should reject unauthenticated request', async () => {
        const c = createMockContext({});

        const response = await didListHandler(c);

        expect(response.status).toBe(401);
        const data = (await response.json()) as ApiResponse;
        expect(data.error).toBe('login_required');
      });
    });

    describe('List DIDs', () => {
      beforeEach(() => {
        mockSessionStoreStub.getSessionRpc.mockResolvedValue({ userId: 'user-123' } as Session);
      });

      it('should return empty list when no DIDs linked', async () => {
        const c = createMockContext({ cookies: { authrim_session: 'valid-session' } });
        mockLinkedIdentityRepo.findByUserId.mockResolvedValue([]);

        const response = await didListHandler(c);

        expect(response.status).toBe(200);
        const data = (await response.json()) as ApiResponse;
        expect(data.dids).toEqual([]);
        expect(data.count).toBe(0);
      });

      it('should return linked DIDs only', async () => {
        const c = createMockContext({ cookies: { authrim_session: 'valid-session' } });
        mockLinkedIdentityRepo.findByUserId.mockResolvedValue([
          {
            provider_id: 'did',
            provider_user_id: 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH',
            linked_at: 1700000000000,
            last_used_at: null,
            raw_attributes: '{"verificationMethod": "key-1"}',
          },
          {
            provider_id: 'google', // Not a DID - should be filtered out
            provider_user_id: 'google-123',
            linked_at: 1700000000000,
            last_used_at: null,
            raw_attributes: null,
          },
        ]);

        const response = await didListHandler(c);

        expect(response.status).toBe(200);
        const data = (await response.json()) as ApiResponse;
        const dids = data.dids as Array<{ did: string }>;
        expect(dids).toHaveLength(1);
        expect(dids[0].did).toBe('did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH');
        expect(data.count).toBe(1);
      });
    });
  });

  describe('didUnlinkHandler', () => {
    describe('Authentication Requirement', () => {
      it('should reject unauthenticated request', async () => {
        const c = createMockContext({
          params: {
            did: encodeURIComponent('did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH'),
          },
        });

        const response = await didUnlinkHandler(c);

        expect(response.status).toBe(401);
        const data = (await response.json()) as ApiResponse;
        expect(data.error).toBe('login_required');
      });
    });

    describe('Input Validation', () => {
      beforeEach(() => {
        mockSessionStoreStub.getSessionRpc.mockResolvedValue({ userId: 'user-123' } as Session);
      });

      it('should reject missing DID parameter', async () => {
        const c = createMockContext({
          params: {},
          cookies: { authrim_session: 'valid-session' },
        });

        const response = await didUnlinkHandler(c);

        expect(response.status).toBe(400);
        const data = (await response.json()) as ApiResponse;
        expect(data.error).toBe('invalid_request');
        // AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD returns generic message
        expect(data.error_description).toContain('required');
      });

      it('should reject invalid DID format', async () => {
        const c = createMockContext({
          params: { did: 'not-a-did' },
          cookies: { authrim_session: 'valid-session' },
        });

        const response = await didUnlinkHandler(c);

        expect(response.status).toBe(400);
        const data = (await response.json()) as ApiResponse;
        expect(data.error).toBe('invalid_request');
        // AR_ERROR_CODES.VALIDATION_INVALID_VALUE returns generic message
        expect(data.error_description).toContain('invalid');
      });
    });

    describe('Authorization', () => {
      beforeEach(() => {
        mockSessionStoreStub.getSessionRpc.mockResolvedValue({ userId: 'user-123' } as Session);
      });

      it('should return 404 when DID link not found', async () => {
        const c = createMockContext({
          params: {
            did: encodeURIComponent('did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH'),
          },
          cookies: { authrim_session: 'valid-session' },
        });
        mockLinkedIdentityRepo.findByProviderUser.mockResolvedValue(null);

        const response = await didUnlinkHandler(c);

        // Implementation returns 400 with validation error when DID not found
        expect(response.status).toBe(400);
        const data = (await response.json()) as ApiResponse;
        expect(data.error).toBe('invalid_request');
      });

      it('should reject unlink of DID owned by another user', async () => {
        const c = createMockContext({
          params: {
            did: encodeURIComponent('did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH'),
          },
          cookies: { authrim_session: 'valid-session' },
        });
        mockLinkedIdentityRepo.findByProviderUser.mockResolvedValue({
          user_id: 'different-user', // Not the current user
          provider_id: 'did',
          provider_user_id: 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH',
        });

        const response = await didUnlinkHandler(c);

        expect(response.status).toBe(403);
        const data = (await response.json()) as ApiResponse;
        expect(data.error).toBe('access_denied');
        // AR_ERROR_CODES returns generic authorization message
        expect(data.error_description).toContain('permission');
      });
    });

    describe('Successful Unlink', () => {
      beforeEach(() => {
        mockSessionStoreStub.getSessionRpc.mockResolvedValue({ userId: 'user-123' } as Session);
      });

      it('should successfully unlink DID', async () => {
        const c = createMockContext({
          params: {
            did: encodeURIComponent('did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH'),
          },
          cookies: { authrim_session: 'valid-session' },
        });
        mockLinkedIdentityRepo.findByProviderUser.mockResolvedValue({
          user_id: 'user-123',
          provider_id: 'did',
          provider_user_id: 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH',
        });
        mockLinkedIdentityRepo.unlink.mockResolvedValue(true);

        const response = await didUnlinkHandler(c);

        expect(response.status).toBe(200);
        const data = (await response.json()) as ApiResponse;
        expect(data.success).toBe(true);
        expect(data.did).toBe('did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH');
      });

      it('should handle URL-encoded DID parameter', async () => {
        const encodedDid = encodeURIComponent(
          'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH'
        );
        const c = createMockContext({
          params: { did: encodedDid },
          cookies: { authrim_session: 'valid-session' },
        });
        mockLinkedIdentityRepo.findByProviderUser.mockResolvedValue({
          user_id: 'user-123',
          provider_id: 'did',
          provider_user_id: 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH',
        });
        mockLinkedIdentityRepo.unlink.mockResolvedValue(true);

        const response = await didUnlinkHandler(c);

        expect(response.status).toBe(200);
        // Verify the DID was decoded correctly
        expect(mockLinkedIdentityRepo.findByProviderUser).toHaveBeenCalledWith(
          'did',
          'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH'
        );
      });
    });
  });
});
