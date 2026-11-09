import { createECDH } from 'node:crypto';
import type { Context } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../../types';
import { didResolveRoute } from '../resolve';

type CacheHit = {
  document: Record<string, unknown>;
  metadata: { created?: string };
};

const mocks = vi.hoisted(() => {
  const logger = {
    error: vi.fn(),
    warn: vi.fn(),
  };
  return {
    logger,
    getValidCache: vi.fn(async (_did: string): Promise<CacheHit | null> => null),
    cacheDocument: vi.fn(
      async (_did: string, _document: Record<string, unknown>, _ttl: number) => {}
    ),
    safeFetch: vi.fn(
      async (_url: string, _options: unknown): Promise<Response> => new Response('{}')
    ),
    resolveAdapter: vi.fn(async (_env: unknown, _purpose: string, _options: unknown) => ({})),
  };
});

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getLogger: () => ({ module: () => mocks.logger }),
    createLogger: () => ({ module: () => mocks.logger }),
    getTenantIdFromContext: () => 'tenant-a',
    resolveAuthCorePersistenceAdapterFromEnv: mocks.resolveAdapter,
    safeFetch: mocks.safeFetch,
    DIDDocumentCacheRepository: class {
      getValidCache = mocks.getValidCache;
      cacheDocument = mocks.cacheDocument;
    },
  };
});

function context(did: string): Context<{ Bindings: Env }> {
  return {
    env: {} as Env,
    req: { param: () => did },
    json: (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
  } as unknown as Context<{ Bindings: Env }>;
}

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  let encoded = '';
  while (value > 0n) {
    encoded = BASE58[Number(value % 58n)] + encoded;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    encoded = `1${encoded}`;
  }
  return encoded;
}

function didKey(codec: readonly number[], publicKey: Uint8Array): string {
  return `did:key:z${base58(Uint8Array.from([...codec, ...publicKey]))}`;
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function resolve(did: string) {
  const response = await didResolveRoute(context(did));
  return {
    response,
    body: await response.json<{
      didDocument?: {
        id: string;
        verificationMethod: Array<{
          publicKeyJwk: Record<string, string>;
        }>;
      };
      didResolutionMetadata: { error?: string; message?: string };
    }>(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getValidCache.mockResolvedValue(null);
  mocks.safeFetch.mockResolvedValue(new Response('{}'));
  mocks.resolveAdapter.mockResolvedValue({});
});

describe('DID resolution cache and remote document boundaries', () => {
  it('returns a tenant-scoped cached document without fetching or rewriting it', async () => {
    const document = { id: 'did:web:example.test' };
    const metadata = { created: '2026-11-01T00:00:00Z' };
    mocks.getValidCache.mockResolvedValue({ document, metadata });

    const { response, body } = await resolve('did:web:example.test');

    expect(response.status).toBe(200);
    expect(body.didDocument).toEqual(document);
    expect(mocks.resolveAdapter).toHaveBeenCalledWith(
      context('did:web:example.test').env,
      'vc-did-resolver',
      { tenantId: 'tenant-a' }
    );
    expect(mocks.safeFetch).not.toHaveBeenCalled();
    expect(mocks.cacheDocument).not.toHaveBeenCalled();
  });

  it('requires bounded HTTPS fetching and caches only a successfully parsed document', async () => {
    const document = { id: 'did:web:example.test' };
    mocks.safeFetch.mockResolvedValue(new Response(JSON.stringify(document)));

    const { response, body } = await resolve('did:web:example.test');

    expect(response.status).toBe(200);
    expect(body.didDocument).toEqual(document);
    expect(mocks.safeFetch).toHaveBeenCalledWith('https://example.test/.well-known/did.json', {
      headers: { Accept: 'application/did+json, application/json' },
      requireHttps: true,
      timeoutMs: 10000,
      maxResponseSize: 512 * 1024,
    });
    expect(mocks.cacheDocument).toHaveBeenCalledWith('did:web:example.test', document, 3600);
  });

  it('does not cache an invalid JSON document', async () => {
    mocks.safeFetch.mockResolvedValue(new Response('{broken'));

    const { response, body } = await resolve('did:web:example.test');

    expect(response.status).toBe(404);
    expect(body.didResolutionMetadata.error).toBe('notFound');
    expect(mocks.cacheDocument).not.toHaveBeenCalled();
  });

  it('rejects a DID over the route length limit before allocating persistence', async () => {
    const { response, body } = await resolve(`did:key:z${'1'.repeat(4096)}`);

    expect(response.status).toBe(400);
    expect(body.didResolutionMetadata.error).toBe('invalidDid');
    expect(mocks.resolveAdapter).not.toHaveBeenCalled();
  });

  it('hides decoding errors from the response and skips persistence', async () => {
    const { response, body } = await resolve('did%:web:example.test');

    expect(response.status).toBe(500);
    expect(body.didResolutionMetadata).toEqual({
      error: 'internalError',
      message: 'An error occurred while resolving the DID',
    });
    expect(mocks.resolveAdapter).not.toHaveBeenCalled();
  });
});

describe('did:key multicodec and curve boundaries', () => {
  const curves = [
    { name: 'P-256', nodeName: 'prime256v1', codec: [0x80, 0x24], size: 32 },
    { name: 'P-384', nodeName: 'secp384r1', codec: [0x81, 0x24], size: 48 },
    { name: 'P-521', nodeName: 'secp521r1', codec: [0x82, 0x24], size: 66 },
    { name: 'secp256k1', nodeName: 'secp256k1', codec: [0xe7, 0x01], size: 32 },
  ] as const;

  it.each(curves)('recovers the exact $name public key from compressed form', async (curve) => {
    const ecdh = createECDH(curve.nodeName);
    ecdh.setPrivateKey(Uint8Array.from([1]));
    const did = didKey(curve.codec, ecdh.getPublicKey(undefined, 'compressed'));
    const uncompressed = ecdh.getPublicKey(undefined, 'uncompressed');

    const { response, body } = await resolve(did);

    expect(response.status).toBe(200);
    expect(body.didDocument?.id).toBe(did);
    expect(body.didDocument?.verificationMethod[0].publicKeyJwk).toEqual({
      kty: 'EC',
      crv: curve.name,
      x: base64url(uncompressed.subarray(1, curve.size + 1)),
      y: base64url(uncompressed.subarray(curve.size + 1)),
    });
    expect(mocks.cacheDocument).toHaveBeenCalledOnce();
  });

  it('accepts an uncompressed P-256 key without changing its coordinates', async () => {
    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(Uint8Array.from([1]));
    const publicKey = ecdh.getPublicKey(undefined, 'uncompressed');
    const did = didKey([0x80, 0x24], publicKey);

    const { response, body } = await resolve(did);

    expect(response.status).toBe(200);
    expect(body.didDocument?.verificationMethod[0].publicKeyJwk).toEqual({
      kty: 'EC',
      crv: 'P-256',
      x: base64url(publicKey.subarray(1, 33)),
      y: base64url(publicKey.subarray(33)),
    });
  });

  it.each([
    { name: 'unterminated multicodec varint', key: [0x80, 0x80] },
    { name: 'unknown multicodec', key: [0x00, 0x01] },
    { name: 'wrong compressed-point prefix', key: [0x80, 0x24, 0x04, ...new Uint8Array(32)] },
    { name: 'truncated P-256 key', key: [0x80, 0x24, 0x02, ...new Uint8Array(31)] },
  ])('rejects $name without caching', async ({ key }) => {
    const { response, body } = await resolve(didKey([], Uint8Array.from(key)));

    expect(response.status).toBe(404);
    expect(body.didResolutionMetadata.error).toBe('notFound');
    expect(mocks.cacheDocument).not.toHaveBeenCalled();
  });

  it('rejects an oversized multibase key before base58 decoding or caching', async () => {
    const { response, body } = await resolve(`did:key:z${'1'.repeat(513)}`);

    expect(response.status).toBe(404);
    expect(body.didResolutionMetadata.error).toBe('notFound');
    expect(mocks.cacheDocument).not.toHaveBeenCalled();
  });
});
