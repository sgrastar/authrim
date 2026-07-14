import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context } from 'hono';
import type { Env } from '../../../types';
import { vciTokenRoute } from '../token';

const mocks = vi.hoisted(() => ({
  parsePreAuthorizedCode: vi.fn(),
  getCredentialOfferStoreById: vi.fn(),
  hashTransactionCode: vi.fn(),
  sha256Base64url: vi.fn(),
}));

vi.mock('../../../utils/credential-offer-sharding', () => ({
  parsePreAuthorizedCode: mocks.parsePreAuthorizedCode,
  getCredentialOfferStoreById: mocks.getCredentialOfferStoreById,
}));

vi.mock('../../../utils/crypto', () => ({
  hashTransactionCode: mocks.hashTransactionCode,
  sha256Base64url: mocks.sha256Base64url,
}));

vi.mock('../../../request-identifiers', () => ({
  getRequestIssuerUrl: vi.fn().mockReturnValue('https://issuer.example.com'),
}));

const PRE_AUTHORIZED_CODE_GRANT = 'urn:ietf:params:oauth:grant-type:pre-authorized_code';
const OFFER_ID = 'g1:apac:3:co_550e8400-e29b-41d4-a716-446655440000';

type OfferStub = { fetch: ReturnType<typeof vi.fn<(request: Request) => Promise<Response>>> };

function createOfferStub(handler?: (request: Request) => Promise<Response> | Response): OfferStub {
  return {
    fetch: vi.fn(async (request: Request) => {
      if (handler) return await handler(request);
      const path = new URL(request.url).pathname;
      if (path === '/reserve') {
        return Response.json({
          reserved: true,
          reservationId: 'reservation-1',
          offer: {
            userId: 'user-1',
            tenantId: 'tenant-1',
            credentialConfigurationId: 'IdentityCredential',
            claims: { given_name: 'Alice' },
          },
        });
      }
      if (path === '/complete') return Response.json({ completed: true });
      if (path === '/release') return Response.json({ released: true });
      return new Response(null, { status: 404 });
    }),
  };
}

function createContext(
  options: {
    contentType?: string;
    form?: Record<string, string>;
    offerStub?: OfferStub;
    sign?: ReturnType<typeof vi.fn>;
  } = {}
): Context<{ Bindings: Env }> {
  const offerStub = options.offerStub ?? createOfferStub();
  const sign = options.sign ?? vi.fn().mockResolvedValue({ token: 'signed-access-token' });
  mocks.getCredentialOfferStoreById.mockReturnValue({ stub: offerStub });

  const env = {
    VC_TRANSACTION_CODE_HMAC_SECRET: '0123456789abcdef0123456789abcdef',
    KEY_MANAGER: {
      idFromName: vi.fn().mockReturnValue({ toString: () => 'key-manager-id' }),
      get: vi.fn().mockReturnValue({ signVCIAccessTokenRpc: sign }),
    },
  } as unknown as Env;
  const contentType = options.contentType ?? 'application/x-www-form-urlencoded';
  const form = options.form ?? {
    grant_type: PRE_AUTHORIZED_CODE_GRANT,
    'pre-authorized_code': 'pre-authorized-code',
  };

  return {
    env,
    req: {
      raw: new Request('https://issuer.example.com/vci/token', { method: 'POST' }),
      header: vi.fn((name: string) =>
        name.toLowerCase() === 'content-type' ? contentType : undefined
      ),
      parseBody: vi.fn().mockResolvedValue(form),
    },
    json: vi.fn((data: unknown, status?: number) => Response.json(data, { status: status ?? 200 })),
    header: vi.fn(),
    get: vi.fn((key: string) => (key === 'tenantId' ? 'tenant-1' : undefined)),
  } as unknown as Context<{ Bindings: Env }>;
}

async function requestPaths(stub: OfferStub): Promise<string[]> {
  return stub.fetch.mock.calls.map(([request]) => new URL(request.url).pathname);
}

describe('VCI token route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.parsePreAuthorizedCode.mockReturnValue({ offerId: OFFER_ID });
    mocks.hashTransactionCode.mockResolvedValue('tx-code-hash');
    mocks.sha256Base64url.mockResolvedValue('pre-authorized-code-hash');
  });

  it('requires a form-urlencoded request before parsing credentials', async () => {
    const c = createContext({ contentType: 'application/json' });
    const response = await vciTokenRoute(c);
    expect(response.status).toBe(400);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(c.req.parseBody).not.toHaveBeenCalled();
  });

  it.each([
    [{ 'pre-authorized_code': 'code' }, 'invalid_request'],
    [{ grant_type: 'authorization_code', 'pre-authorized_code': 'code' }, 'unauthorized_client'],
    [{ grant_type: PRE_AUTHORIZED_CODE_GRANT }, 'invalid_request'],
  ])('rejects an invalid grant request %#', async (form, expectedError) => {
    const response = await vciTokenRoute(createContext({ form }));
    expect(response.status).toBe(400);
    expect((await response.json()) as { error: string }).toMatchObject({ error: expectedError });
  });

  it('rejects malformed and unknown single-use codes without touching a shard', async () => {
    mocks.parsePreAuthorizedCode.mockReturnValue(null);
    const response = await vciTokenRoute(createContext());
    expect(response.status).toBe(400);
    expect(mocks.getCredentialOfferStoreById).not.toHaveBeenCalled();
  });

  it.each([
    [new Response(null, { status: 409 })],
    [Response.json({ reserved: false })],
    [Response.json({ reserved: true, offer: { userId: 'user-1' } })],
  ])('rejects an offer that cannot be atomically reserved %#', async (reserveResponse) => {
    const stub = createOfferStub(async () => reserveResponse);
    const response = await vciTokenRoute(createContext({ offerStub: stub }));
    expect(response.status).toBe(400);
  });

  it('binds the optional transaction code and offer identity into the reservation', async () => {
    const stub = createOfferStub();
    const sign = vi.fn().mockResolvedValue({ token: 'signed-access-token' });
    const c = createContext({
      offerStub: stub,
      sign,
      form: {
        grant_type: PRE_AUTHORIZED_CODE_GRANT,
        'pre-authorized_code': 'pre-authorized-code',
        tx_code: '123456',
      },
    });

    const response = await vciTokenRoute(c);
    const data = (await response.json()) as Record<string, unknown>;
    expect(response.status).toBe(200);
    expect(data).toMatchObject({
      access_token: 'signed-access-token',
      token_type: 'Bearer',
      expires_in: 3600,
    });
    expect(mocks.hashTransactionCode).toHaveBeenCalledWith(
      c.env.VC_TRANSACTION_CODE_HMAC_SECRET,
      'tenant-1',
      OFFER_ID,
      '123456'
    );
    const reserveRequest = stub.fetch.mock.calls[0]?.[0];
    expect(await reserveRequest?.clone().json()).toMatchObject({
      id: OFFER_ID,
      tenantId: 'tenant-1',
      preAuthorizedCodeHash: 'pre-authorized-code-hash',
      txCodeHash: 'tx-code-hash',
    });
    expect(sign).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      userId: 'user-1',
      offerId: OFFER_ID,
      credentialConfigurationId: 'IdentityCredential',
      issuer: 'https://issuer.example.com',
      expiresInSeconds: 3600,
    });
    expect(await requestPaths(stub)).toEqual(['/reserve', '/complete']);
    expect(c.header).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(c.header).toHaveBeenCalledWith('Pragma', 'no-cache');
  });

  it('does not derive a transaction-code hash for an unprotected offer', async () => {
    const response = await vciTokenRoute(createContext());
    expect(response.status).toBe(200);
    expect(mocks.hashTransactionCode).not.toHaveBeenCalled();
  });

  it('releases the reservation when signing fails', async () => {
    const stub = createOfferStub();
    const response = await vciTokenRoute(
      createContext({
        offerStub: stub,
        sign: vi.fn().mockRejectedValue(new Error('key manager unavailable')),
      })
    );
    expect(response.status).toBe(500);
    expect(await requestPaths(stub)).toEqual(['/reserve', '/release']);
  });

  it('releases the reservation when the atomic completion transition fails', async () => {
    const stub = createOfferStub(async (request) => {
      const path = new URL(request.url).pathname;
      if (path === '/reserve') {
        return Response.json({
          reserved: true,
          reservationId: 'reservation-1',
          offer: {
            userId: 'user-1',
            tenantId: 'tenant-1',
            credentialConfigurationId: 'IdentityCredential',
            claims: {},
          },
        });
      }
      if (path === '/complete') return Response.json({ completed: false });
      return Response.json({ released: true });
    });
    const response = await vciTokenRoute(createContext({ offerStub: stub }));
    expect(response.status).toBe(500);
    expect(await requestPaths(stub)).toEqual(['/reserve', '/complete', '/release']);
  });

  it('fails closed when shard routing throws', async () => {
    const c = createContext();
    mocks.getCredentialOfferStoreById.mockImplementation(() => {
      throw new Error('invalid shard');
    });
    const response = await vciTokenRoute(c);
    expect(response.status).toBe(400);
  });

  it('keeps the original server error when reservation cleanup also fails', async () => {
    const stub = createOfferStub(async (request) => {
      const path = new URL(request.url).pathname;
      if (path === '/reserve') {
        return Response.json({
          reserved: true,
          reservationId: 'reservation-1',
          offer: {
            userId: 'user-1',
            tenantId: 'tenant-1',
            credentialConfigurationId: 'IdentityCredential',
            claims: {},
          },
        });
      }
      throw new Error('release unavailable');
    });
    const response = await vciTokenRoute(
      createContext({
        offerStub: stub,
        sign: vi.fn().mockRejectedValue(new Error('signing unavailable')),
      })
    );
    expect(response.status).toBe(500);
    expect(await requestPaths(stub)).toEqual(['/reserve', '/release']);
  });
});
