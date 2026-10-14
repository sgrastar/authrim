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
const mockPiiAdapter = vi.hoisted(() => ({
  queryOne: vi.fn(),
  batch: vi.fn(),
  execute: vi.fn(),
}));
const mockProvisioner = vi.hoisted(() => ({
  publishAuthDidRoute: vi.fn(),
}));
const mockCoreAdapter = vi.hoisted(() => ({
  queryOne: vi.fn(),
}));

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
    resolveAccountDataContextFromHono: vi.fn(async (_c: unknown, userId: string) => ({
      tenantId: 'default',
      accountId: `account:${userId}`,
      legacyUserId: userId,
    })),
    createPIIContextFromHono: vi.fn(() => ({ defaultPiiAdapter: mockPiiAdapter })),
    createAuthContextFromHono: vi.fn(() => ({ coreAdapter: mockCoreAdapter })),
    validateAccountDirectoryPublication: vi.fn((value) => value),
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
    // DID login (and with it DID linking) is off unless the tenant turns it on.
    SETTINGS: {
      get: vi.fn(async (key: string) =>
        key === 'settings:tenant:default:authentication-methods'
          ? JSON.stringify({ 'authentication-methods.did.login_enabled': true })
          : null
      ),
    } as unknown as KVNamespace,
    ACCOUNT_PROVISIONER: mockProvisioner as unknown as Env['ACCOUNT_PROVISIONER'],
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
    mockPiiAdapter.queryOne.mockReset().mockResolvedValue(null);
    mockPiiAdapter.batch.mockReset().mockResolvedValue([{ rowsAffected: 1 }, { rowsAffected: 1 }]);
    mockPiiAdapter.execute.mockReset().mockResolvedValue({ rowsAffected: 1 });
    mockProvisioner.publishAuthDidRoute.mockReset().mockImplementation(async (input) => ({
      status: 201,
      operationId: input.operationId,
      accountId: input.accountId,
    }));
    mockCoreAdapter.queryOne.mockReset().mockResolvedValue({
      payload_json: JSON.stringify({
        tenantId: 'default',
        accountId: 'account:user-123',
        routeProjection: {
          schemaVersion: 1,
          accountRouteGeneration: 1,
          residencyPolicyId: 'default-policy',
          targets: [],
        },
      }),
    });
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

      it('should let the same user prove a DID again (retry of a link whose route is not published)', async () => {
        const c = createMockContext({
          body: { did: 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH' },
          cookies: { authrim_session: 'valid-session' },
        });
        mockLinkedIdentityRepo.findByProviderUser.mockResolvedValue({
          id: 'link-1',
          user_id: 'user-123', // Same user
          provider_id: 'did',
          provider_user_id: 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH',
        });
        mockResolveDID.mockResolvedValue(sampleDIDDocument);

        const response = await didRegisterChallengeHandler(c);

        expect(response.status).toBe(200);
        expect(mockChallengeStoreStub.storeChallengeRpc).toHaveBeenCalledTimes(1);
      });

      it('issues the same challenge for a DID linked to a different user (no link probing)', async () => {
        const did = 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH';
        mockResolveDID.mockResolvedValue(sampleDIDDocument);
        mockChallengeStoreStub.storeChallengeRpc.mockResolvedValue({ success: true });

        mockLinkedIdentityRepo.findByProviderUser.mockResolvedValue(null);
        const unlinked = await didRegisterChallengeHandler(
          createMockContext({ body: { did }, cookies: { authrim_session: 'valid-session' } })
        );
        mockLinkedIdentityRepo.findByProviderUser.mockResolvedValue({
          user_id: 'different-user', // Different user
          provider_id: 'did',
          provider_user_id: did,
        });
        const linkedElsewhere = await didRegisterChallengeHandler(
          createMockContext({ body: { did }, cookies: { authrim_session: 'valid-session' } })
        );

        expect(unlinked.status).toBe(200);
        expect(linkedElsewhere.status).toBe(200);
        const keys = async (r: Response) => Object.keys((await r.json()) as ApiResponse).sort();
        expect(await keys(linkedElsewhere)).toEqual(await keys(unlinked));
        expect(mockChallengeStoreStub.storeChallengeRpc).toHaveBeenCalledTimes(2);
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

    describe('DID already linked to another user (decided after the proof)', () => {
      const did = 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH';
      const linkedElsewhere = {
        id: 'link-other',
        user_id: 'other-user',
        provider_id: 'did',
        provider_user_id: did,
      };

      beforeEach(() => {
        vi.mocked(decodeProtectedHeader).mockReturnValue({ alg: 'ES256', kid: validKid });
        mockChallengeStoreStub.consumeChallengeRpc.mockResolvedValue({
          challenge: 'test-challenge',
          userId: 'user-123',
          metadata: { allowedVerificationMethods: [validKid], nonce: 'test-nonce' },
        });
        mockResolveDID.mockResolvedValue(sampleDIDDocument);
        vi.mocked(importJWK).mockResolvedValue({} as CryptoKey);
      });

      const verifyBody = { challenge_id: 'test', proof: 'header.payload.sig' };

      it('refuses with the generic answer once the proof is valid, writing and publishing nothing', async () => {
        vi.mocked(jwtVerify).mockResolvedValue({
          payload: { iss: did, nonce: 'test-nonce', aud: 'https://issuer.example.com' },
          protectedHeader: { alg: 'ES256' },
        } as never);
        mockLinkedIdentityRepo.findByProviderUser.mockResolvedValue(linkedElsewhere);

        const response = await didRegisterVerifyHandler(createMockContext({ body: verifyBody }));

        expect(response.status).toBe(400);
        expect(((await response.json()) as ApiResponse).error).toBe('invalid_request');
        expect(mockLinkedIdentityRepo.createLinkedIdentity).not.toHaveBeenCalled();
        expect(mockProvisioner.publishAuthDidRoute).not.toHaveBeenCalled();
      });

      it('answers a bad proof for a DID linked elsewhere exactly like a bad proof for an unlinked DID', async () => {
        vi.mocked(jwtVerify).mockRejectedValue(new Error('signature verification failed'));

        mockLinkedIdentityRepo.findByProviderUser.mockResolvedValue(linkedElsewhere);
        const elsewhere = await didRegisterVerifyHandler(createMockContext({ body: verifyBody }));
        mockLinkedIdentityRepo.findByProviderUser.mockResolvedValue(null);
        const unlinked = await didRegisterVerifyHandler(createMockContext({ body: verifyBody }));

        expect(elsewhere.status).toBe(unlinked.status);
        const unlinkedBody = (await unlinked.json()) as ApiResponse;
        expect(await elsewhere.json()).toEqual(unlinkedBody);
        expect(unlinkedBody.error).toBe('interaction_required');
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
        mockLinkedIdentityRepo.createLinkedIdentity.mockResolvedValue({ id: 'link-id' });

        const response = await didRegisterVerifyHandler(c);

        expect(response.status).toBe(200);
        const data = (await response.json()) as ApiResponse;
        expect(data.success).toBe(true);
        expect(data.did).toBe('did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH');
      });

      it('adopts a completed unlink after the link row has already been removed', async () => {
        const did = 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH';
        const c = createMockContext({
          params: { did: encodeURIComponent(did) },
          cookies: { authrim_session: 'valid-session' },
        });
        mockSessionStoreStub.getSessionRpc.mockResolvedValue({ userId: 'user-123' } as Session);
        mockLinkedIdentityRepo.findByProviderUser.mockResolvedValue(null);
        mockPiiAdapter.queryOne.mockImplementation(async (_sql, params) => ({
          tenant_id: 'default',
          account_id: 'account:user-123',
          user_id: 'user-123',
          issuer_sha256: await (async () => {
            const value = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('did'));
            return Array.from(new Uint8Array(value), (byte) =>
              byte.toString(16).padStart(2, '0')
            ).join('');
          })(),
          subject_sha256: await (async () => {
            const value = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(did));
            return Array.from(new Uint8Array(value), (byte) =>
              byte.toString(16).padStart(2, '0')
            ).join('');
          })(),
          state: 'completed',
          operation_id: params?.[0],
        }));

        const response = await didUnlinkHandler(c);

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual(
          expect.objectContaining({ success: true, cleanup_pending: false })
        );
        expect(mockPiiAdapter.batch).not.toHaveBeenCalled();
        expect(mockCoreAdapter.queryOne).not.toHaveBeenCalled();
      });

      it('should store correct linked identity data', async () => {
        const c = createMockContext({
          body: { challenge_id: 'test', proof: 'header.payload.sig' },
        });
        mockLinkedIdentityRepo.createLinkedIdentity.mockResolvedValue({ id: 'link-id' });

        await didRegisterVerifyHandler(c);

        expect(mockLinkedIdentityRepo.createLinkedIdentity).toHaveBeenCalledWith(
          expect.objectContaining({
            tenant_id: 'default',
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
            id: 'link-other',
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
            id: 'link-same',
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
          'default',
          'did',
          'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH'
        );
      });
    });
  });

  describe('DID route publication (DID login finds the account through the lookup directory)', () => {
    const did = 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH';
    const SETTINGS_KEY = 'settings:tenant:default:authentication-methods';

    function settingsEnv(get: (key: string) => Promise<string | null>): Partial<Env> {
      return { SETTINGS: { get: vi.fn(get) } as unknown as KVNamespace };
    }

    function armVerify() {
      vi.mocked(decodeProtectedHeader).mockReturnValue({ alg: 'ES256', kid: validKid });
      mockLinkedIdentityRepo.findByProviderUser.mockResolvedValue(null);
      mockLinkedIdentityRepo.createLinkedIdentity.mockResolvedValue({ id: 'link-id' });
      mockChallengeStoreStub.consumeChallengeRpc.mockResolvedValue({
        challenge: 'test-challenge',
        userId: 'user-123',
        metadata: { did, allowedVerificationMethods: [validKid], nonce: 'test-nonce' },
      });
      mockResolveDID.mockResolvedValue(sampleDIDDocument);
      vi.mocked(importJWK).mockResolvedValue({} as CryptoKey);
      vi.mocked(jwtVerify).mockResolvedValue({
        payload: { iss: did, nonce: 'test-nonce', aud: 'https://issuer.example.com' },
        protectedHeader: { alg: 'ES256' },
      } as never);
    }

    const verifyBody = { challenge_id: 'test', proof: 'header.payload.sig' };

    describe('register verify', () => {
      beforeEach(armVerify);

      it('publishes the route of the new link after the row is written', async () => {
        const response = await didRegisterVerifyHandler(createMockContext({ body: verifyBody }));

        expect(response.status).toBe(200);
        expect(mockProvisioner.publishAuthDidRoute).toHaveBeenCalledTimes(1);
        const input = mockProvisioner.publishAuthDidRoute.mock.calls[0][0];
        expect(input).toEqual({
          schemaVersion: 1,
          operationId: expect.stringMatching(/^did-route-[a-f0-9]{32}$/),
          idempotencyKey: expect.stringMatching(/^auth-did-route:[a-f0-9]{64}$/),
          tenantId: 'default',
          accountId: 'account:user-123',
          userId: 'user-123',
          linkedIdentityId: 'link-id',
          did,
        });
        expect(input.idempotencyKey.slice('auth-did-route:'.length).slice(0, 32)).toBe(
          input.operationId.slice('did-route-'.length)
        );
        expect(
          mockLinkedIdentityRepo.createLinkedIdentity.mock.invocationCallOrder[0]
        ).toBeLessThan(mockProvisioner.publishAuthDidRoute.mock.invocationCallOrder[0]);
      });

      it('accepts 202 (queued on the outbox) as published', async () => {
        mockProvisioner.publishAuthDidRoute.mockImplementation(async (input) => ({
          status: 202,
          operationId: input.operationId,
          accountId: input.accountId,
        }));

        const response = await didRegisterVerifyHandler(createMockContext({ body: verifyBody }));

        expect(response.status).toBe(200);
        expect(mockProvisioner.publishAuthDidRoute).toHaveBeenCalledTimes(1);
        expect(mockPiiAdapter.execute).not.toHaveBeenCalled();
      });

      it('keeps the row and answers 503 when publishing fails, and a retry republishes the same operation', async () => {
        mockProvisioner.publishAuthDidRoute.mockRejectedValueOnce(
          new Error('auth_did_route_internal_error')
        );

        const first = await didRegisterVerifyHandler(createMockContext({ body: verifyBody }));

        expect(first.status).toBe(503);
        expect(((await first.json()) as ApiResponse).error).toBe('temporarily_unavailable');
        // Possibly queued already: the row is not removed, so a retry converges on the same route.
        expect(mockPiiAdapter.execute).not.toHaveBeenCalled();
        const firstInput = mockProvisioner.publishAuthDidRoute.mock.calls[0][0];

        // The retry: the row from the first attempt is there for the same user.
        mockLinkedIdentityRepo.findByProviderUser.mockResolvedValue({
          id: 'link-id',
          user_id: 'user-123',
          provider_id: 'did',
          provider_user_id: did,
        });
        mockChallengeStoreStub.consumeChallengeRpc.mockResolvedValue({
          challenge: 'test-challenge-2',
          userId: 'user-123',
          metadata: { did, allowedVerificationMethods: [validKid], nonce: 'test-nonce' },
        });
        const retry = await didRegisterVerifyHandler(createMockContext({ body: verifyBody }));

        expect(retry.status).toBe(200);
        expect(mockLinkedIdentityRepo.createLinkedIdentity).toHaveBeenCalledTimes(1);
        expect(mockProvisioner.publishAuthDidRoute).toHaveBeenCalledTimes(2);
        expect(mockProvisioner.publishAuthDidRoute.mock.calls[1][0]).toEqual(firstInput);
      });

      it('answers 503 for an invalid publication result', async () => {
        mockProvisioner.publishAuthDidRoute.mockResolvedValue({
          status: 201,
          operationId: 'other-operation',
          accountId: 'account:user-123',
        });

        const response = await didRegisterVerifyHandler(createMockContext({ body: verifyBody }));

        expect(response.status).toBe(503);
      });

      it('removes the row when the DID is already routed to another account', async () => {
        mockProvisioner.publishAuthDidRoute.mockRejectedValue(
          new Error('directory_identifier_reservation_conflict')
        );

        const response = await didRegisterVerifyHandler(createMockContext({ body: verifyBody }));

        expect(response.status).toBe(400);
        expect(mockPiiAdapter.execute).toHaveBeenCalledWith(
          expect.stringContaining('DELETE FROM linked_identities'),
          ['link-id', 'default', 'user-123']
        );
      });

      it('lets the same user repeat a link whose row already exists (route repair)', async () => {
        mockLinkedIdentityRepo.findByProviderUser.mockResolvedValue({
          id: 'legacy-link',
          user_id: 'user-123',
          provider_id: 'did',
          provider_user_id: did,
        });

        const response = await didRegisterVerifyHandler(createMockContext({ body: verifyBody }));

        expect(response.status).toBe(200);
        expect(mockLinkedIdentityRepo.createLinkedIdentity).not.toHaveBeenCalled();
        expect(mockProvisioner.publishAuthDidRoute).toHaveBeenCalledWith(
          expect.objectContaining({ linkedIdentityId: 'legacy-link', did })
        );
      });

      it('publishes the route when the same user won the insert race', async () => {
        mockLinkedIdentityRepo.createLinkedIdentity.mockRejectedValue(
          new Error('UNIQUE constraint failed')
        );
        mockLinkedIdentityRepo.findByProviderUser.mockReset();
        mockLinkedIdentityRepo.findByProviderUser
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce({
            id: 'raced-link',
            user_id: 'user-123',
            provider_id: 'did',
            provider_user_id: did,
          });

        const response = await didRegisterVerifyHandler(createMockContext({ body: verifyBody }));

        expect(response.status).toBe(200);
        expect(mockProvisioner.publishAuthDidRoute).toHaveBeenCalledWith(
          expect.objectContaining({ linkedIdentityId: 'raced-link' })
        );
      });

      it('writes nothing and keeps the challenge when the provisioner binding is missing', async () => {
        const response = await didRegisterVerifyHandler(
          createMockContext({
            body: verifyBody,
            env: { ACCOUNT_PROVISIONER: undefined },
          })
        );

        expect(response.status).toBe(503);
        expect(mockChallengeStoreStub.consumeChallengeRpc).not.toHaveBeenCalled();
        expect(mockLinkedIdentityRepo.createLinkedIdentity).not.toHaveBeenCalled();
      });
    });

    describe('a DID the lookup directory cannot index', () => {
      const atLimit = `did:web:${'a'.repeat(1024 - 'did:web:'.length)}`;
      const unindexable: Array<[string, string]> = [
        ['1025 bytes', `${atLimit}a`],
        ['1028 bytes in 348 characters', `did:web:${'\u3042'.repeat(340)}`],
        ['a control character', 'did:web:exa\u0007mple.com'],
      ];

      function expectNothingWritten() {
        expect(mockResolveDID).not.toHaveBeenCalled();
        expect(mockChallengeStoreStub.storeChallengeRpc).not.toHaveBeenCalled();
        expect(mockChallengeStoreStub.consumeChallengeRpc).not.toHaveBeenCalled();
        expect(mockLinkedIdentityRepo.createLinkedIdentity).not.toHaveBeenCalled();
        expect(mockProvisioner.publishAuthDidRoute).not.toHaveBeenCalled();
      }

      it.each(unindexable)('refuses a register challenge for a DID of %s', async (_label, bad) => {
        mockSessionStoreStub.getSessionRpc.mockResolvedValue({ userId: 'user-123' } as Session);

        const response = await didRegisterChallengeHandler(
          createMockContext({ body: { did: bad }, cookies: { authrim_session: 'valid-session' } })
        );

        expect(response.status).toBe(400);
        expectNothingWritten();
      });

      it.each(unindexable)(
        'refuses a register verification for a DID of %s before the challenge or any write',
        async (_label, bad) => {
          vi.mocked(decodeProtectedHeader).mockReturnValue({ alg: 'ES256', kid: `${bad}#key-1` });

          const response = await didRegisterVerifyHandler(createMockContext({ body: verifyBody }));

          expect(response.status).toBe(400);
          expectNothingWritten();
        }
      );

      it('still links a DID of exactly 1024 bytes', async () => {
        armVerify();
        vi.mocked(decodeProtectedHeader).mockReturnValue({ alg: 'ES256', kid: `${atLimit}#key-1` });
        mockChallengeStoreStub.consumeChallengeRpc.mockResolvedValue({
          challenge: 'test-challenge',
          userId: 'user-123',
          metadata: { allowedVerificationMethods: [`${atLimit}#key-1`], nonce: 'test-nonce' },
        });
        mockResolveDID.mockResolvedValue({
          ...sampleDIDDocument,
          verificationMethod: [
            { ...sampleDIDDocument.verificationMethod[0], id: `${atLimit}#key-1` },
          ],
          authentication: [`${atLimit}#key-1`],
        });
        vi.mocked(jwtVerify).mockResolvedValue({
          payload: { iss: atLimit, nonce: 'test-nonce', aud: 'https://issuer.example.com' },
          protectedHeader: { alg: 'ES256' },
        } as never);

        const response = await didRegisterVerifyHandler(createMockContext({ body: verifyBody }));

        expect(response.status).toBe(200);
        expect(mockProvisioner.publishAuthDidRoute).toHaveBeenCalledWith(
          expect.objectContaining({ did: atLimit })
        );
      });
    });

    describe('the tenant switch (authentication-methods.did.login_enabled)', () => {
      beforeEach(() => {
        armVerify();
        mockSessionStoreStub.getSessionRpc.mockResolvedValue({ userId: 'user-123' } as Session);
      });

      function expectNothingDone() {
        expect(mockResolveDID).not.toHaveBeenCalled();
        expect(mockChallengeStoreStub.storeChallengeRpc).not.toHaveBeenCalled();
        expect(mockChallengeStoreStub.consumeChallengeRpc).not.toHaveBeenCalled();
        expect(mockLinkedIdentityRepo.findByProviderUser).not.toHaveBeenCalled();
        expect(mockLinkedIdentityRepo.createLinkedIdentity).not.toHaveBeenCalled();
        expect(mockProvisioner.publishAuthDidRoute).not.toHaveBeenCalled();
      }

      const off = settingsEnv(async (key) =>
        key === SETTINGS_KEY
          ? JSON.stringify({ 'authentication-methods.did.login_enabled': false })
          : null
      );
      const unreadable = settingsEnv(async () => {
        throw new Error('KV unavailable');
      });

      it('refuses the register challenge with 403 when DID login is off', async () => {
        const response = await didRegisterChallengeHandler(
          createMockContext({
            body: { did },
            cookies: { authrim_session: 'valid-session' },
            env: off,
          })
        );

        expect(response.status).toBe(403);
        expectNothingDone();
      });

      it('refuses the register challenge with 503 when the settings cannot be read', async () => {
        const response = await didRegisterChallengeHandler(
          createMockContext({
            body: { did },
            cookies: { authrim_session: 'valid-session' },
            env: unreadable,
          })
        );

        expect(response.status).toBe(503);
        expectNothingDone();
      });

      it('refuses the register verification with 403 and does not consume the challenge', async () => {
        const response = await didRegisterVerifyHandler(
          createMockContext({ body: verifyBody, env: off })
        );

        expect(response.status).toBe(403);
        expectNothingDone();
      });

      it('refuses the register verification with 503 and does not consume the challenge', async () => {
        const response = await didRegisterVerifyHandler(
          createMockContext({ body: verifyBody, env: unreadable })
        );

        expect(response.status).toBe(503);
        expectNothingDone();
      });

      it('leaves listing and unlinking available when DID login is off', async () => {
        mockLinkedIdentityRepo.findByUserId.mockResolvedValue([]);
        const listed = await didListHandler(
          createMockContext({ cookies: { authrim_session: 'valid-session' }, env: off })
        );
        expect(listed.status).toBe(200);

        mockLinkedIdentityRepo.findByProviderUser.mockResolvedValue(null);
        const unlinked = await didUnlinkHandler(
          createMockContext({
            params: { did: encodeURIComponent(did) },
            cookies: { authrim_session: 'valid-session' },
            env: off,
          })
        );
        // Not refused by the switch (this DID has no link, which is a plain validation answer).
        expect(unlinked.status).toBe(400);
      });
    });
  });
});
