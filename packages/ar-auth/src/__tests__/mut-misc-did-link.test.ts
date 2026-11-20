import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';
import { AR_ERROR_CODES, resolveAccountDataContextFromHono, type Env } from '@authrim/ar-lib-core';

// Response type for test assertions - permissive to allow property access without narrowing
type ApiResponse = Record<string, unknown>;

const mockIssuer = vi.hoisted(() => vi.fn());
vi.mock('../issuer', () => ({ getRequestIssuer: mockIssuer }));

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
// The account's own core database, shaped like a DatabaseAdapter (ensureDatabaseAdapter keeps it).
const mockCoreAdapter = vi.hoisted(() => ({
  queryOne: vi.fn(),
  query: vi.fn(),
  execute: vi.fn(),
  transaction: vi.fn(),
  batch: vi.fn(),
  isHealthy: vi.fn(),
  getType: vi.fn(),
  close: vi.fn(),
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
      // The account's own core database (not the tenant metadata one).
      coreDb: mockCoreAdapter,
    })),
    createPIIContextFromHono: vi.fn(() => ({ defaultPiiAdapter: mockPiiAdapter })),
    // The tenant metadata core database holds no accounts: reading the account's creation record
    // from it must fail (this is what made every unlink fail on the real environment).
    createAuthContextFromHono: vi.fn(() => ({
      coreAdapter: { queryOne: vi.fn(async () => null) },
    })),
    validateAccountDirectoryPublication: vi.fn((value: unknown) => value),
    LinkedIdentityRepository: class {
      constructor() {}
      findByProviderUser = mockLinkedIdentityRepo.findByProviderUser;
      findByUserId = mockLinkedIdentityRepo.findByUserId;
      createLinkedIdentity = mockLinkedIdentityRepo.createLinkedIdentity;
      unlink = mockLinkedIdentityRepo.unlink;
    },
  };
});

import { didRegisterChallengeHandler, didRegisterVerifyHandler } from '../did-link';
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

const did = 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH';
const signedIn = { authrim_session: 'session-1' };
const verifyBody = { challenge_id: 'test', proof: 'header.payload.sig' };

async function answer(response: Response) {
  return { status: response.status, body: await response.json<ApiResponse>() };
}

function armVerify() {
  vi.mocked(decodeProtectedHeader).mockReturnValue({ alg: 'ES256', kid: validKid });
  mockLinkedIdentityRepo.findByProviderUser.mockResolvedValue(null);
  mockLinkedIdentityRepo.createLinkedIdentity.mockResolvedValue({ id: 'link-id' });
  mockChallengeStoreStub.consumeChallengeRpc.mockResolvedValue({
    userId: 'user-123',
    metadata: { did, allowedVerificationMethods: [validKid], nonce: 'test-nonce' },
  });
  mockResolveDID.mockResolvedValue(sampleDIDDocument);
  vi.mocked(importJWK).mockResolvedValue(new Uint8Array(32));
  vi.mocked(jwtVerify).mockResolvedValue({
    payload: { iss: did, nonce: 'test-nonce' },
    protectedHeader: { alg: 'ES256' },
  });
}

const verify = (body: Record<string, unknown> = verifyBody) =>
  didRegisterVerifyHandler(createMockContext({ body }));

beforeEach(() => {
  vi.clearAllMocks();
  mockIssuer.mockReset().mockReturnValue('https://issuer.example.com');
  mockResolveDID.mockReset();
  mockChallengeStoreStub.storeChallengeRpc.mockReset().mockResolvedValue(undefined);
  mockChallengeStoreStub.consumeChallengeRpc.mockReset();
  mockSessionStoreStub.getSessionRpc.mockReset().mockResolvedValue({ userId: 'user-123' });
  mockLinkedIdentityRepo.findByProviderUser.mockReset();
  mockLinkedIdentityRepo.findByUserId.mockReset();
  mockLinkedIdentityRepo.createLinkedIdentity.mockReset();
  mockPiiAdapter.queryOne.mockReset().mockResolvedValue(null);
  mockPiiAdapter.batch.mockReset().mockResolvedValue([{ rowsAffected: 1 }, { rowsAffected: 1 }]);
  mockPiiAdapter.execute.mockReset().mockResolvedValue({ rowsAffected: 1 });
  mockProvisioner.publishAuthDidRoute
    .mockReset()
    .mockImplementation(async (input: { operationId: string; accountId: string }) => ({
      status: 201,
      operationId: input.operationId,
      accountId: input.accountId,
    }));
  mockCoreAdapter.queryOne.mockReset().mockResolvedValue({
    payload_json: JSON.stringify({
      tenantId: 'default',
      accountId: 'account:user-123',
      routeProjection: { schemaVersion: 1, targets: [] },
    }),
  });
  armVerify();
});

describe('DID register challenge edge cases', () => {
  it('treats a failing session store as signed out', async () => {
    mockSessionStoreStub.getSessionRpc.mockRejectedValue(new Error('down'));
    const { body } = await answer(
      await didRegisterChallengeHandler(createMockContext({ cookies: signedIn, body: { did } }))
    );
    expect(body.error_code).toBe(AR_ERROR_CODES.AUTH_LOGIN_REQUIRED);
  });

  it('refuses a blank did as a missing field', async () => {
    const { status, body } = await answer(
      await didRegisterChallengeHandler(
        createMockContext({ cookies: signedIn, body: { did: ' ' } })
      )
    );
    expect(status).toBe(400);
    expect(body.error_code).toBe(AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD);
  });

  it('answers server_error when the challenge cannot be stored', async () => {
    mockChallengeStoreStub.storeChallengeRpc.mockRejectedValue(new Error('down'));
    const { status, body } = await answer(
      await didRegisterChallengeHandler(createMockContext({ cookies: signedIn, body: { did } }))
    );
    expect(status).toBe(500);
    expect(body.error_code).toBe(AR_ERROR_CODES.INTERNAL_ERROR);
  });
});

describe('DID register verify refusals', () => {
  it('refuses a blank proof as a missing field', async () => {
    const { body } = await answer(await verify({ challenge_id: 'x', proof: '  ' }));
    expect(body.error_code).toBe(AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD);
  });

  it('refuses an undecodable proof before consuming the challenge', async () => {
    vi.mocked(decodeProtectedHeader).mockImplementation(() => {
      throw new Error('bad');
    });
    const { body } = await answer(await verify());
    expect(body.error_code).toBe(AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    expect(mockChallengeStoreStub.consumeChallengeRpc).not.toHaveBeenCalled();
  });

  it('refuses a proof without a kid as a missing field', async () => {
    vi.mocked(decodeProtectedHeader).mockReturnValue({ alg: 'ES256' });
    const { body } = await answer(await verify());
    expect(body.error_code).toBe(AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD);
  });

  it('refuses a kid that is not a DID URL', async () => {
    vi.mocked(decodeProtectedHeader).mockReturnValue({ alg: 'ES256', kid: 'key-1' });
    const { body } = await answer(await verify());
    expect(body.error_code).toBe(AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    expect(mockChallengeStoreStub.consumeChallengeRpc).not.toHaveBeenCalled();
  });

  it('refuses a challenge that cannot be consumed', async () => {
    mockChallengeStoreStub.consumeChallengeRpc.mockRejectedValue(new Error('consumed'));
    const { body } = await answer(await verify());
    expect(body.error_code).toBe(AR_ERROR_CODES.AUTH_INVALID_CODE);
  });

  it.each([undefined, '', 7])('refuses a challenge naming the user %j', async (userId) => {
    mockChallengeStoreStub.consumeChallengeRpc.mockResolvedValue({
      userId,
      metadata: { allowedVerificationMethods: [validKid], nonce: 'test-nonce' },
    });
    const { body } = await answer(await verify());
    expect(body.error_code).toBe(AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    expect(mockResolveDID).not.toHaveBeenCalled();
  });

  it('refuses a challenge without allowed methods', async () => {
    mockChallengeStoreStub.consumeChallengeRpc.mockResolvedValue({ userId: 'user-123' });
    const { body } = await answer(await verify());
    expect(body.error_code).toBe(AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    expect(mockResolveDID).not.toHaveBeenCalled();
  });

  it.each([
    ['the DID cannot be resolved', () => mockResolveDID.mockRejectedValue(new Error('x'))],
    ['the key cannot be imported', () => vi.mocked(importJWK).mockRejectedValue(new Error('x'))],
  ])('refuses when %s', async (_label, arrange) => {
    arrange();
    const { body } = await answer(await verify());
    expect(body.error_code).toBe(AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    expect(jwtVerify).not.toHaveBeenCalled();
  });

  it('answers server_error without an issuer and verifies nothing', async () => {
    mockIssuer.mockReturnValue('');
    const { status } = await answer(await verify());
    expect(status).toBe(500);
    expect(jwtVerify).not.toHaveBeenCalled();
  });

  it('verifies the proof for the request issuer', async () => {
    await verify();
    expect(jwtVerify).toHaveBeenCalledWith(
      'header.payload.sig',
      expect.anything(),
      expect.objectContaining({ audience: 'https://issuer.example.com' })
    );
  });

  it('answers server_error when the account resolves to another user', async () => {
    vi.mocked(resolveAccountDataContextFromHono).mockResolvedValueOnce({
      legacyUserId: 'user-999',
    } as never);
    const { status } = await answer(await verify());
    expect(status).toBe(500);
    expect(mockLinkedIdentityRepo.createLinkedIdentity).not.toHaveBeenCalled();
  });
});
