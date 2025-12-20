/**
 * DID Authentication Handler Tests
 *
 * Comprehensive security tests for DID-based authentication including:
 * - Input validation and sanitization
 * - Challenge generation and consumption
 * - JWS signature verification
 * - Algorithm restriction enforcement
 * - Replay attack prevention
 * - Session creation
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';
import type { Env } from '@authrim/shared';

// Response type for test assertions - permissive to allow property access without narrowing
type ApiResponse = Record<string, unknown>;

// Mock jose module
vi.mock('jose', () => ({
  jwtVerify: vi.fn(),
  importJWK: vi.fn(),
  decodeProtectedHeader: vi.fn(),
}));

// Mock functions using vi.hoisted
const mockChallengeStoreStub = vi.hoisted(() => ({
  storeChallengeRpc: vi.fn(),
  consumeChallengeRpc: vi.fn(),
}));

const mockSessionStoreStub = vi.hoisted(() => ({
  createSessionRpc: vi.fn(),
}));

const mockLinkedIdentityRepo = vi.hoisted(() => ({
  findByProviderUser: vi.fn(),
}));

const mockResolveDID = vi.hoisted(() => vi.fn());

// Mock @authrim/shared
vi.mock('@authrim/shared', async () => {
  const actual = await vi.importActual('@authrim/shared');
  return {
    ...actual,
    getChallengeStoreByDID: vi.fn(() => mockChallengeStoreStub),
    getSessionStoreForNewSession: vi.fn(() =>
      Promise.resolve({
        stub: mockSessionStoreStub,
        sessionId: 'mock-session-id',
      })
    ),
    resolveDID: mockResolveDID,
    D1Adapter: class {
      constructor() {}
    },
    LinkedIdentityRepository: class {
      constructor() {}
      findByProviderUser = mockLinkedIdentityRepo.findByProviderUser;
    },
  };
});

import { didAuthChallengeHandler, didAuthVerifyHandler } from '../did-auth';
import { jwtVerify, importJWK, decodeProtectedHeader } from 'jose';

// Helper to create mock context
function createMockContext(overrides: {
  body?: Record<string, unknown>;
  env?: Partial<Env>;
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

  return {
    req: {
      json: vi.fn().mockResolvedValue(overrides.body ?? {}),
    },
    env: defaultEnv,
    json: vi.fn((data: unknown, status?: number) => {
      return new Response(JSON.stringify(data), {
        status: status ?? 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
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

describe('DID Authentication', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveDID.mockReset();
    mockChallengeStoreStub.storeChallengeRpc.mockReset();
    mockChallengeStoreStub.consumeChallengeRpc.mockReset();
    mockSessionStoreStub.createSessionRpc.mockReset();
    mockLinkedIdentityRepo.findByProviderUser.mockReset();
  });

  describe('didAuthChallengeHandler', () => {
    describe('Input Validation', () => {
      it('should reject missing DID', async () => {
        const c = createMockContext({ body: {} });
        const response = await didAuthChallengeHandler(c);

        expect(response.status).toBe(400);
        const data = (await response.json()) as ApiResponse;
        expect(data.error).toBe('invalid_request');
        expect(data.error_description).toContain('DID is required');
      });

      it('should reject null DID', async () => {
        const c = createMockContext({ body: { did: null } });
        const response = await didAuthChallengeHandler(c);

        expect(response.status).toBe(400);
        const data = (await response.json()) as ApiResponse;
        expect(data.error).toBe('invalid_request');
      });

      it('should reject empty string DID', async () => {
        const c = createMockContext({ body: { did: '' } });
        const response = await didAuthChallengeHandler(c);

        expect(response.status).toBe(400);
        const data = (await response.json()) as ApiResponse;
        expect(data.error).toBe('invalid_request');
      });

      it('should reject whitespace-only DID', async () => {
        const c = createMockContext({ body: { did: '   ' } });
        const response = await didAuthChallengeHandler(c);

        expect(response.status).toBe(400);
        const data = (await response.json()) as ApiResponse;
        expect(data.error).toBe('invalid_request');
      });

      it('should reject DID without did: prefix', async () => {
        const c = createMockContext({
          body: { did: 'key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH' },
        });
        const response = await didAuthChallengeHandler(c);

        expect(response.status).toBe(400);
        const data = (await response.json()) as ApiResponse;
        expect(data.error).toBe('invalid_request');
        expect(data.error_description).toContain('Invalid DID format');
      });

      it('should reject SQL injection in DID', async () => {
        const c = createMockContext({ body: { did: "did:'; DROP TABLE users--" } });
        mockResolveDID.mockRejectedValue(new Error('Invalid DID'));
        const response = await didAuthChallengeHandler(c);

        expect(response.status).toBe(400);
        const data = (await response.json()) as ApiResponse;
        expect(data.error).toBe('invalid_did');
      });
    });

    describe('DID Resolution', () => {
      it('should return error when DID resolution fails', async () => {
        const c = createMockContext({ body: { did: 'did:web:nonexistent.com' } });
        mockResolveDID.mockRejectedValue(new Error('Failed to resolve DID'));

        const response = await didAuthChallengeHandler(c);

        expect(response.status).toBe(400);
        const data = (await response.json()) as ApiResponse;
        expect(data.error).toBe('invalid_did');
        expect(data.error_description).toContain('Failed to resolve DID');
      });

      it('should return error when DID document has no authentication methods', async () => {
        const c = createMockContext({
          body: { did: 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH' },
        });
        mockResolveDID.mockResolvedValue({
          id: 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH',
          authentication: [],
          verificationMethod: [],
        });

        const response = await didAuthChallengeHandler(c);

        expect(response.status).toBe(400);
        const data = (await response.json()) as ApiResponse;
        expect(data.error).toBe('invalid_did');
        expect(data.error_description).toContain('No authentication methods');
      });

      it('should handle DID document with inline verification methods', async () => {
        const c = createMockContext({
          body: { did: 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH' },
        });
        mockResolveDID.mockResolvedValue({
          id: 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH',
          authentication: [
            {
              id: 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH#key-1',
              type: 'JsonWebKey2020',
              controller: 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH',
              publicKeyJwk: { kty: 'OKP', crv: 'Ed25519', x: 'test' },
            },
          ],
        });
        mockChallengeStoreStub.storeChallengeRpc.mockResolvedValue({ success: true });

        const response = await didAuthChallengeHandler(c);

        expect(response.status).toBe(200);
        const data = (await response.json()) as ApiResponse;
        expect(data.allowed_verification_methods).toHaveLength(1);
      });
    });

    describe('Challenge Generation', () => {
      it('should generate challenge successfully for valid DID', async () => {
        const c = createMockContext({
          body: { did: 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH' },
        });
        mockResolveDID.mockResolvedValue(sampleDIDDocument);
        mockChallengeStoreStub.storeChallengeRpc.mockResolvedValue({ success: true });

        const response = await didAuthChallengeHandler(c);

        expect(response.status).toBe(200);
        const data = (await response.json()) as ApiResponse;
        expect(data.challenge_id).toBeDefined();
        expect(data.challenge).toBeDefined();
        expect(data.nonce).toBeDefined();
        expect(data.expires_in).toBe(300);
        expect(data.allowed_verification_methods).toHaveLength(1);
      });

      it('should store challenge with correct parameters', async () => {
        const c = createMockContext({
          body: { did: 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH' },
        });
        mockResolveDID.mockResolvedValue(sampleDIDDocument);
        mockChallengeStoreStub.storeChallengeRpc.mockResolvedValue({ success: true });

        await didAuthChallengeHandler(c);

        expect(mockChallengeStoreStub.storeChallengeRpc).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'did_authentication',
            ttl: 300,
            metadata: expect.objectContaining({
              did: 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH',
              allowedVerificationMethods: expect.any(Array),
              nonce: expect.any(String),
            }),
          })
        );
      });

      it('should not include private key material in response', async () => {
        const c = createMockContext({
          body: { did: 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH' },
        });
        mockResolveDID.mockResolvedValue({
          ...sampleDIDDocument,
          verificationMethod: [
            {
              ...sampleDIDDocument.verificationMethod[0],
              publicKeyJwk: {
                kty: 'OKP',
                crv: 'Ed25519',
                x: 'public-x',
                d: 'PRIVATE_KEY_SHOULD_NOT_BE_HERE', // This should be stripped
              },
            },
          ],
        });
        mockChallengeStoreStub.storeChallengeRpc.mockResolvedValue({ success: true });

        const response = await didAuthChallengeHandler(c);

        expect(response.status).toBe(200);
        const data = (await response.json()) as ApiResponse;
        const methods = data.allowed_verification_methods as Array<{
          publicKeyJwk?: { d?: string };
        }>;
        const jwk = methods[0].publicKeyJwk;
        expect(jwk?.d).toBeUndefined();
      });
    });
  });

  describe('didAuthVerifyHandler', () => {
    const validKid =
      'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH#z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH';

    describe('Input Validation', () => {
      it('should reject missing challenge_id', async () => {
        const c = createMockContext({ body: { proof: 'valid.jwt.token' } });
        const response = await didAuthVerifyHandler(c);

        expect(response.status).toBe(400);
        const data = (await response.json()) as ApiResponse;
        expect(data.error).toBe('invalid_request');
      });

      it('should reject missing proof', async () => {
        const c = createMockContext({ body: { challenge_id: 'test-challenge' } });
        const response = await didAuthVerifyHandler(c);

        expect(response.status).toBe(400);
        const data = (await response.json()) as ApiResponse;
        expect(data.error).toBe('invalid_request');
      });

      it('should reject empty challenge_id', async () => {
        const c = createMockContext({ body: { challenge_id: '', proof: 'valid.jwt.token' } });
        const response = await didAuthVerifyHandler(c);

        expect(response.status).toBe(400);
        const data = (await response.json()) as ApiResponse;
        expect(data.error).toBe('invalid_request');
      });

      it('should reject whitespace-only proof', async () => {
        const c = createMockContext({ body: { challenge_id: 'test', proof: '   ' } });
        const response = await didAuthVerifyHandler(c);

        expect(response.status).toBe(400);
        const data = (await response.json()) as ApiResponse;
        expect(data.error).toBe('invalid_request');
      });
    });

    describe('JWS Format Validation', () => {
      it('should reject invalid JWS format', async () => {
        const c = createMockContext({ body: { challenge_id: 'test', proof: 'not-a-jwt' } });
        vi.mocked(decodeProtectedHeader).mockImplementation(() => {
          throw new Error('Invalid format');
        });

        const response = await didAuthVerifyHandler(c);

        expect(response.status).toBe(400);
        const data = (await response.json()) as ApiResponse;
        expect(data.error).toBe('invalid_proof');
        expect(data.error_description).toContain('Invalid JWS format');
      });

      it('should reject JWS without kid header', async () => {
        const c = createMockContext({
          body: { challenge_id: 'test', proof: 'header.payload.sig' },
        });
        vi.mocked(decodeProtectedHeader).mockReturnValue({ alg: 'ES256' });

        const response = await didAuthVerifyHandler(c);

        expect(response.status).toBe(400);
        const data = (await response.json()) as ApiResponse;
        expect(data.error).toBe('invalid_proof');
        expect(data.error_description).toContain('kid header');
      });

      it('should reject kid that is not a DID URL', async () => {
        const c = createMockContext({
          body: { challenge_id: 'test', proof: 'header.payload.sig' },
        });
        vi.mocked(decodeProtectedHeader).mockReturnValue({ alg: 'ES256', kid: 'not-a-did-url' });

        const response = await didAuthVerifyHandler(c);

        expect(response.status).toBe(400);
        const data = (await response.json()) as ApiResponse;
        expect(data.error).toBe('invalid_proof');
        expect(data.error_description).toContain('DID URL');
      });
    });

    describe('Challenge Verification', () => {
      it('should reject expired or non-existent challenge', async () => {
        const c = createMockContext({
          body: { challenge_id: 'expired-challenge', proof: 'header.payload.sig' },
        });
        vi.mocked(decodeProtectedHeader).mockReturnValue({ alg: 'ES256', kid: validKid });
        mockChallengeStoreStub.consumeChallengeRpc.mockRejectedValue(
          new Error('Challenge not found')
        );

        const response = await didAuthVerifyHandler(c);

        expect(response.status).toBe(400);
        const data = (await response.json()) as ApiResponse;
        expect(data.error).toBe('invalid_challenge');
        expect(data.error_description).toContain('not found or expired');
      });

      it('should reject verification method not in allowed list', async () => {
        const c = createMockContext({
          body: { challenge_id: 'test', proof: 'header.payload.sig' },
        });
        vi.mocked(decodeProtectedHeader).mockReturnValue({
          alg: 'ES256',
          kid: 'did:key:z6MkDifferentKey#key-1',
        });
        mockChallengeStoreStub.consumeChallengeRpc.mockResolvedValue({
          challenge: 'test-challenge',
          metadata: {
            did: 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH',
            allowedVerificationMethods: [validKid],
            nonce: 'test-nonce',
          },
        });

        const response = await didAuthVerifyHandler(c);

        expect(response.status).toBe(400);
        const data = (await response.json()) as ApiResponse;
        expect(data.error).toBe('invalid_proof');
        expect(data.error_description).toContain('Verification method not allowed');
      });
    });

    describe('Signature Verification', () => {
      beforeEach(() => {
        vi.mocked(decodeProtectedHeader).mockReturnValue({ alg: 'ES256', kid: validKid });
        mockChallengeStoreStub.consumeChallengeRpc.mockResolvedValue({
          challenge: 'test-challenge',
          metadata: {
            did: 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH',
            allowedVerificationMethods: [validKid],
            nonce: 'test-nonce',
          },
        });
        mockResolveDID.mockResolvedValue(sampleDIDDocument);
      });

      it('should return 503 when ISSUER_URL is not configured', async () => {
        const c = createMockContext({
          body: { challenge_id: 'test', proof: 'header.payload.sig' },
          env: { ISSUER_URL: undefined },
        });
        vi.mocked(importJWK).mockResolvedValue({} as CryptoKey);

        const response = await didAuthVerifyHandler(c);

        expect(response.status).toBe(503);
        const data = (await response.json()) as ApiResponse;
        expect(data.error).toBe('temporarily_unavailable');
      });

      it('should reject when signature verification fails', async () => {
        const c = createMockContext({
          body: { challenge_id: 'test', proof: 'header.payload.sig' },
        });
        vi.mocked(importJWK).mockResolvedValue({} as CryptoKey);
        vi.mocked(jwtVerify).mockRejectedValue(new Error('Signature verification failed'));

        const response = await didAuthVerifyHandler(c);

        expect(response.status).toBe(400);
        const data = (await response.json()) as ApiResponse;
        expect(data.error).toBe('invalid_proof');
        expect(data.error_description).toContain('Signature verification failed');
      });

      it('should reject when issuer claim does not match DID', async () => {
        const c = createMockContext({
          body: { challenge_id: 'test', proof: 'header.payload.sig' },
        });
        vi.mocked(importJWK).mockResolvedValue({} as CryptoKey);
        vi.mocked(jwtVerify).mockResolvedValue({
          payload: {
            iss: 'did:key:z6MkDifferentIssuer', // Wrong issuer
            nonce: 'test-nonce',
            aud: 'https://issuer.example.com',
          },
          protectedHeader: { alg: 'ES256' },
        } as never);

        const response = await didAuthVerifyHandler(c);

        expect(response.status).toBe(400);
        const data = (await response.json()) as ApiResponse;
        expect(data.error).toBe('invalid_proof');
        expect(data.error_description).toContain('Issuer must match DID');
      });

      it('should reject when nonce does not match', async () => {
        const c = createMockContext({
          body: { challenge_id: 'test', proof: 'header.payload.sig' },
        });
        vi.mocked(importJWK).mockResolvedValue({} as CryptoKey);
        vi.mocked(jwtVerify).mockResolvedValue({
          payload: {
            iss: 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH',
            nonce: 'wrong-nonce',
            aud: 'https://issuer.example.com',
          },
          protectedHeader: { alg: 'ES256' },
        } as never);

        const response = await didAuthVerifyHandler(c);

        expect(response.status).toBe(400);
        const data = (await response.json()) as ApiResponse;
        expect(data.error).toBe('invalid_proof');
        expect(data.error_description).toContain('Nonce mismatch');
      });
    });

    describe('DID Linking Check', () => {
      beforeEach(() => {
        vi.mocked(decodeProtectedHeader).mockReturnValue({ alg: 'ES256', kid: validKid });
        mockChallengeStoreStub.consumeChallengeRpc.mockResolvedValue({
          challenge: 'test-challenge',
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

      it('should reject when DID is not linked to any account', async () => {
        const c = createMockContext({
          body: { challenge_id: 'test', proof: 'header.payload.sig' },
        });
        mockLinkedIdentityRepo.findByProviderUser.mockResolvedValue(null);

        const response = await didAuthVerifyHandler(c);

        expect(response.status).toBe(400);
        const data = (await response.json()) as ApiResponse;
        expect(data.error).toBe('did_not_linked');
        expect(data.error_description).toContain('not linked to any account');
      });
    });

    describe('Session Creation', () => {
      beforeEach(() => {
        vi.mocked(decodeProtectedHeader).mockReturnValue({ alg: 'ES256', kid: validKid });
        mockChallengeStoreStub.consumeChallengeRpc.mockResolvedValue({
          challenge: 'test-challenge',
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
        mockLinkedIdentityRepo.findByProviderUser.mockResolvedValue({
          user_id: 'linked-user-id',
          provider_id: 'did',
          provider_user_id: 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH',
        });
      });

      it('should create session on successful verification', async () => {
        const c = createMockContext({
          body: { challenge_id: 'test', proof: 'header.payload.sig' },
        });
        mockSessionStoreStub.createSessionRpc.mockResolvedValue({ success: true });

        const response = await didAuthVerifyHandler(c);

        expect(response.status).toBe(200);
        const data = (await response.json()) as ApiResponse;
        expect(data.session_id).toBe('mock-session-id');
        expect(data.user_id).toBe('linked-user-id');
        expect(data.expires_in).toBe(86400);
      });

      it('should include correct session metadata', async () => {
        const c = createMockContext({
          body: { challenge_id: 'test', proof: 'header.payload.sig' },
        });
        mockSessionStoreStub.createSessionRpc.mockResolvedValue({ success: true });

        await didAuthVerifyHandler(c);

        expect(mockSessionStoreStub.createSessionRpc).toHaveBeenCalledWith(
          'mock-session-id',
          'linked-user-id',
          86400,
          expect.objectContaining({
            amr: ['did'],
            acr: 'urn:authrim:acr:did',
            did: 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH',
            verification_method: validKid,
          })
        );
      });
    });

    describe('Security: Replay Attack Prevention', () => {
      it('should reject reuse of consumed challenge', async () => {
        const c = createMockContext({
          body: { challenge_id: 'test', proof: 'header.payload.sig' },
        });
        vi.mocked(decodeProtectedHeader).mockReturnValue({ alg: 'ES256', kid: validKid });

        // First call consumes the challenge
        mockChallengeStoreStub.consumeChallengeRpc.mockResolvedValueOnce({
          challenge: 'test-challenge',
          metadata: {
            did: 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH',
            allowedVerificationMethods: [validKid],
            nonce: 'test-nonce',
          },
        });

        // Second call should fail
        mockChallengeStoreStub.consumeChallengeRpc.mockRejectedValueOnce(
          new Error('Challenge not found')
        );

        // First request succeeds (setup remaining mocks)
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
        mockLinkedIdentityRepo.findByProviderUser.mockResolvedValue({
          user_id: 'linked-user-id',
          provider_id: 'did',
          provider_user_id: 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH',
        });
        mockSessionStoreStub.createSessionRpc.mockResolvedValue({ success: true });

        const response1 = await didAuthVerifyHandler(c);
        expect(response1.status).toBe(200);

        // Second request with same challenge should fail
        const response2 = await didAuthVerifyHandler(c);
        expect(response2.status).toBe(400);
        const data = (await response2.json()) as ApiResponse;
        expect(data.error).toBe('invalid_challenge');
      });
    });

    describe('Security: DID Document Verification', () => {
      beforeEach(() => {
        vi.mocked(decodeProtectedHeader).mockReturnValue({ alg: 'ES256', kid: validKid });
        mockChallengeStoreStub.consumeChallengeRpc.mockResolvedValue({
          challenge: 'test-challenge',
          metadata: {
            did: 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH',
            allowedVerificationMethods: [validKid],
            nonce: 'test-nonce',
          },
        });
      });

      it('should reject when DID resolution fails during verification', async () => {
        const c = createMockContext({
          body: { challenge_id: 'test', proof: 'header.payload.sig' },
        });
        mockResolveDID.mockRejectedValue(new Error('DID resolution failed'));

        const response = await didAuthVerifyHandler(c);

        expect(response.status).toBe(400);
        const data = (await response.json()) as ApiResponse;
        expect(data.error).toBe('invalid_did');
      });

      it('should reject when verification method not found in DID document', async () => {
        const c = createMockContext({
          body: { challenge_id: 'test', proof: 'header.payload.sig' },
        });
        mockResolveDID.mockResolvedValue({
          id: 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH',
          verificationMethod: [], // No verification methods
        });

        const response = await didAuthVerifyHandler(c);

        expect(response.status).toBe(400);
        const data = (await response.json()) as ApiResponse;
        expect(data.error).toBe('invalid_proof');
        expect(data.error_description).toContain('Verification method not found');
      });

      it('should reject when verification method has no public key', async () => {
        const c = createMockContext({
          body: { challenge_id: 'test', proof: 'header.payload.sig' },
        });
        mockResolveDID.mockResolvedValue({
          id: 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH',
          verificationMethod: [
            {
              id: validKid,
              type: 'JsonWebKey2020',
              controller: 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH',
              // No publicKeyJwk
            },
          ],
        });

        const response = await didAuthVerifyHandler(c);

        expect(response.status).toBe(400);
        const data = (await response.json()) as ApiResponse;
        expect(data.error).toBe('invalid_proof');
        expect(data.error_description).toContain('no public key');
      });

      it('should reject when public key import fails', async () => {
        const c = createMockContext({
          body: { challenge_id: 'test', proof: 'header.payload.sig' },
        });
        mockResolveDID.mockResolvedValue(sampleDIDDocument);
        vi.mocked(importJWK).mockRejectedValue(new Error('Invalid key format'));

        const response = await didAuthVerifyHandler(c);

        expect(response.status).toBe(400);
        const data = (await response.json()) as ApiResponse;
        expect(data.error).toBe('invalid_proof');
        expect(data.error_description).toContain('Failed to import public key');
      });
    });
  });
});
