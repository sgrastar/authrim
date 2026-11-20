import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';
import { AR_ERROR_CODES, type Env } from '@authrim/ar-lib-core';

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

import { didRegisterVerifyHandler, didListHandler, didUnlinkHandler } from '../did-link';
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

describe('DID register verify link races', () => {
  it.each(['UNIQUE constraint failed', 'violates constraint', 'duplicate key'])(
    'reuses the same user link after a %s race',
    async (message) => {
      mockLinkedIdentityRepo.createLinkedIdentity.mockRejectedValue(new Error(message));
      mockLinkedIdentityRepo.findByProviderUser
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 'link-race', user_id: 'user-123' });
      const { status, body } = await answer(await verify());
      expect(status).toBe(200);
      expect(body.message).toBe('DID is already linked to your account');
      expect(mockProvisioner.publishAuthDidRoute).toHaveBeenCalledWith(
        expect.objectContaining({ linkedIdentityId: 'link-race' })
      );
    }
  );

  it('rethrows another insert failure as server_error', async () => {
    mockLinkedIdentityRepo.createLinkedIdentity.mockRejectedValue(new Error('disk full'));
    const { status } = await answer(await verify());
    expect(status).toBe(500);
    expect(mockLinkedIdentityRepo.findByProviderUser).toHaveBeenCalledTimes(1);
  });

  it('refuses a race won by another user', async () => {
    mockLinkedIdentityRepo.createLinkedIdentity.mockRejectedValue('UNIQUE');
    mockLinkedIdentityRepo.findByProviderUser
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'link-race', user_id: 'user-999' });
    const { body } = await answer(await verify());
    expect(body.error_code).toBe(AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    expect(mockProvisioner.publishAuthDidRoute).not.toHaveBeenCalled();
  });

  it.each([
    ['a non-Error rejection', () => mockProvisioner.publishAuthDidRoute.mockRejectedValue('down')],
    [
      'an invalid response status',
      () =>
        mockProvisioner.publishAuthDidRoute.mockImplementation(
          async (input: { operationId: string; accountId: string }) => ({
            status: 200,
            operationId: input.operationId,
            accountId: input.accountId,
          })
        ),
    ],
  ])('keeps the new link for a retry after %s', async (_label, arrange) => {
    arrange();
    const { status, body } = await answer(await verify());
    expect(status).toBe(503);
    expect(body.error).toBe('temporarily_unavailable');
    expect(mockPiiAdapter.execute).not.toHaveBeenCalled();
  });
});

describe('DID list and unlink edge cases', () => {
  it('answers server_error when the links cannot be read', async () => {
    mockLinkedIdentityRepo.findByUserId.mockRejectedValue(new Error('down'));
    const { status, body } = await answer(
      await didListHandler(createMockContext({ cookies: signedIn }))
    );
    expect(status).toBe(500);
    expect(body.error_code).toBe(AR_ERROR_CODES.INTERNAL_ERROR);
  });

  it('refuses an unlink without a did parameter', async () => {
    const { body } = await answer(await didUnlinkHandler(createMockContext({ cookies: signedIn })));
    expect(body.error_code).toBe(AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD);
  });

  it('refuses a parameter that is not a DID', async () => {
    const { body } = await answer(
      await didUnlinkHandler(createMockContext({ cookies: signedIn, params: { did: 'key:x' } }))
    );
    expect(body.error_code).toBe(AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    expect(mockLinkedIdentityRepo.findByProviderUser).not.toHaveBeenCalled();
  });

  const unlink = () =>
    didUnlinkHandler(
      createMockContext({ cookies: signedIn, params: { did: encodeURIComponent(did) } })
    );

  it('answers server_error for an operation of another account', async () => {
    mockLinkedIdentityRepo.findByProviderUser.mockResolvedValue(null);
    mockPiiAdapter.queryOne.mockResolvedValue({
      operation_id: 'op',
      tenant_id: 'default',
      account_id: 'account:other',
      user_id: 'user-123',
      issuer_sha256: 'x',
      subject_sha256: 'y',
      state: 'completed',
    });
    expect((await unlink()).status).toBe(500);
  });

  it.each([
    ['the account route is unavailable', () => mockCoreAdapter.queryOne.mockResolvedValue(null)],
    [
      'the account route names another account',
      () =>
        mockCoreAdapter.queryOne.mockResolvedValue({
          payload_json: JSON.stringify({ tenantId: 'default', accountId: 'account:x' }),
        }),
    ],
    [
      'only one statement of the batch applied',
      () => mockPiiAdapter.batch.mockResolvedValue([{ rowsAffected: 1 }, { rowsAffected: 0 }]),
    ],
  ])('answers server_error when %s', async (_label, arrange) => {
    mockLinkedIdentityRepo.findByProviderUser.mockResolvedValue({
      id: 'link-1',
      user_id: 'user-123',
    });
    arrange();
    const { status, body } = await answer(await unlink());
    expect(status).toBe(500);
    expect(body.error_code).toBe(AR_ERROR_CODES.INTERNAL_ERROR);
  });
});
