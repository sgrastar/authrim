import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import {
  compactDecrypt,
  decodeProtectedHeader,
  exportJWK,
  exportPKCS8,
  generateKeyPair,
  jwtVerify,
  type JWK,
} from 'jose';
import type { Env } from '@authrim/ar-lib-core/types/env';
import { answerFormPostAsData, redirectWithError } from '../authorize';
import { MockKVNamespace } from './helpers/mut-authorize-env';

const mockGetClient = vi.hoisted(() =>
  vi.fn<(env: unknown, clientId: string) => Promise<Record<string, unknown> | null>>()
);
vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getClient: mockGetClient,
    getClientCached: vi.fn((_c: unknown, env: unknown, clientId: string) =>
      mockGetClient(env, clientId)
    ),
  };
});

type Options = NonNullable<Parameters<typeof redirectWithError>[5]>;

let signingKeys: { publicKey: CryptoKey; privateKey: CryptoKey };
let privatePEM: string;
let encryptionKeys: { publicKey: CryptoKey; privateKey: CryptoKey };
let encryptionJwk: JWK;

beforeAll(async () => {
  signingKeys = await generateKeyPair('RS256', { extractable: true });
  privatePEM = await exportPKCS8(signingKeys.privateKey);
  encryptionKeys = await generateKeyPair('RSA-OAEP-256', { extractable: true });
  encryptionJwk = { ...(await exportJWK(encryptionKeys.publicKey)), kid: 'enc-1', use: 'enc' };
});

let keyRpc: ReturnType<typeof vi.fn>;
let env: Env;

beforeEach(() => {
  vi.clearAllMocks();
  mockGetClient.mockResolvedValue({ client_id: 'jarm-client', redirect_uris: [] });
  keyRpc = vi.fn(async () => ({ kid: 'sig-1', privatePEM }));
  env = {
    ISSUER_URL: 'https://issuer.example.com',
    AUTHRIM_CONFIG: new MockKVNamespace() as unknown as KVNamespace,
    KEY_MANAGER: {
      idFromName: vi.fn((name: string) => name),
      get: vi.fn(() => ({ getActiveOIDCSigningKeyWithPrivateRpc: keyRpc })),
    },
  } as unknown as Env;
});

/** Calls redirectWithError for `tenantId` (each test uses its own: signing keys are cached). */
async function send(
  options: Options | undefined,
  { tenantId = 'tenant-x', state = 'st', description = 'desc', asData = false } = {}
): Promise<Response> {
  const app = new Hono<{ Bindings: Env }>();
  app.get('/x', (c) => {
    (c as unknown as { set: (k: string, v: string) => void }).set('tenantId', tenantId);
    if (asData) answerFormPostAsData(c);
    return redirectWithError(
      c,
      'https://rp.example.com/cb?keep=1',
      'access_denied',
      description,
      state,
      options
    );
  });
  return app.request('/x', {}, env);
}

describe('redirectWithError: plain response modes', () => {
  it('puts the error, description, state and iss in the query for a code response', async () => {
    const response = await send({ responseType: 'code' });
    expect(response.status).toBe(302);
    const url = new URL(response.headers.get('Location')!);
    expect(url.origin + url.pathname).toBe('https://rp.example.com/cb');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      keep: '1',
      error: 'access_denied',
      error_description: 'desc',
      state: 'st',
      iss: 'https://issuer.example.com',
    });
    expect(url.hash).toBe('');
  });

  it('leaves out an empty description and state', async () => {
    const response = await send(undefined, { state: '', description: '' });
    const url = new URL(response.headers.get('Location')!);
    expect(url.searchParams.has('error_description')).toBe(false);
    expect(url.searchParams.has('state')).toBe(false);
    expect(url.searchParams.get('error')).toBe('access_denied');
  });

  it.each(['id_token', 'code token', 'code id_token'])(
    'uses the fragment by default for response_type=%s',
    async (responseType) => {
      const response = await send({ responseType, responseMode: '' });
      const url = new URL(response.headers.get('Location')!);
      expect(url.searchParams.has('error')).toBe(false);
      const fragment = new URLSearchParams(url.hash.slice(1));
      expect(fragment.get('error')).toBe('access_denied');
      expect(fragment.get('state')).toBe('st');
      expect(fragment.get('iss')).toBe('https://issuer.example.com');
    }
  );

  it('uses an explicit query mode even for an implicit response', async () => {
    const response = await send({ responseType: 'id_token', responseMode: 'query' });
    const url = new URL(response.headers.get('Location')!);
    expect(url.searchParams.get('error')).toBe('access_denied');
    expect(url.hash).toBe('');
  });

  it('uses an explicit fragment mode for a code response', async () => {
    const response = await send({ responseType: 'code', responseMode: 'fragment' });
    const url = new URL(response.headers.get('Location')!);
    expect(new URLSearchParams(url.hash.slice(1)).get('error')).toBe('access_denied');
  });

  it('answers form_post with an auto-submitting page that escapes the values', async () => {
    const response = await send({ responseMode: 'form_post' }, { state: '"><script>x</script>' });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('action="https://rp.example.com/cb?keep=1"');
    expect(html).toContain('name="error" value="access_denied"');
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('&quot;&gt;&lt;script&gt;');
  });

  it('answers form_post as data when the request asked for it', async () => {
    const response = await send({ responseMode: 'form_post' }, { asData: true });
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({
      form_post: {
        action: 'https://rp.example.com/cb?keep=1',
        fields: [
          ['error', 'access_denied'],
          ['error_description', 'desc'],
          ['state', 'st'],
          ['iss', 'https://issuer.example.com'],
        ],
      },
    });
  });

  it('sends an error to errorUri, and a cancellation to cancelUri', async () => {
    const toError = await send({ errorUri: 'https://rp.example.com/error' });
    expect(toError.headers.get('Location')).toMatch(/^https:\/\/rp\.example\.com\/error\?/);

    const cancelled = await send({
      errorUri: 'https://rp.example.com/error',
      cancelUri: 'https://rp.example.com/cancel',
      isUserCancellation: true,
    });
    expect(cancelled.headers.get('Location')).toMatch(/^https:\/\/rp\.example\.com\/cancel\?/);

    // Not a cancellation: the cancel URI is not used.
    const notCancelled = await send({ cancelUri: 'https://rp.example.com/cancel' });
    expect(notCancelled.headers.get('Location')).toMatch(/^https:\/\/rp\.example\.com\/cb\?/);
  });

  it('falls back to the base mode when a JWT mode has no client_id', async () => {
    const response = await send({ responseMode: 'fragment.jwt' });
    const url = new URL(response.headers.get('Location')!);
    expect(new URLSearchParams(url.hash.slice(1)).get('error')).toBe('access_denied');
    expect(keyRpc).not.toHaveBeenCalled();
  });
});

async function jarmToken(response: Response, where: 'query' | 'fragment'): Promise<string> {
  expect(response.status).toBe(302);
  const url = new URL(response.headers.get('Location')!);
  const params = where === 'query' ? url.searchParams : new URLSearchParams(url.hash.slice(1));
  expect([...params.keys()].filter((k) => k !== 'keep')).toEqual(['response']);
  return params.get('response')!;
}

describe('redirectWithError: JARM', () => {
  it('signs the error parameters for the client in the query (query.jwt)', async () => {
    const response = await send(
      { responseMode: 'query.jwt', clientId: 'jarm-client' },
      { tenantId: 'jarm-a' }
    );
    const token = await jarmToken(response, 'query');
    const header = decodeProtectedHeader(token);
    expect(header).toMatchObject({ alg: 'RS256', typ: 'oauth-authz-resp+jwt', kid: 'sig-1' });
    const { payload } = await jwtVerify(token, signingKeys.publicKey, {
      issuer: 'https://issuer.example.com',
      audience: 'jarm-client',
    });
    expect(payload).toMatchObject({
      error: 'access_denied',
      error_description: 'desc',
      state: 'st',
    });
    expect((payload.exp as number) - (payload.iat as number)).toBe(600);
    expect(keyRpc).toHaveBeenCalledWith('RS256');
    expect(env.KEY_MANAGER.idFromName).toHaveBeenCalledWith('jarm-a-v3');
  });

  it('uses the fragment for jwt mode on an implicit response, the query for code', async () => {
    const implicit = await send(
      { responseMode: 'jwt', responseType: 'id_token', clientId: 'jarm-client' },
      { tenantId: 'jarm-b' }
    );
    await jarmToken(implicit, 'fragment');
    const code = await send(
      { responseMode: 'jwt', responseType: 'code', clientId: 'jarm-client' },
      { tenantId: 'jarm-b' }
    );
    await jarmToken(code, 'query');
  });

  it('posts the JWT in form_post.jwt', async () => {
    const response = await send(
      { responseMode: 'form_post.jwt', clientId: 'jarm-client' },
      { tenantId: 'jarm-c', asData: true }
    );
    const body = await response.json<{ form_post: { fields: [string, string][] } }>();
    expect(body.form_post.fields.map(([k]) => k)).toEqual(['response']);
  });

  it('reuses the cached signing key until the key version changes', async () => {
    const options = { responseMode: 'query.jwt', clientId: 'jarm-client' };
    await send(options, { tenantId: 'jarm-cache' });
    await send(options, { tenantId: 'jarm-cache' });
    expect(keyRpc).toHaveBeenCalledTimes(1);
    await env.AUTHRIM_CONFIG!.put('v1:key-version:jarm-cache', 'rotated');
    await send(options, { tenantId: 'jarm-cache' });
    expect(keyRpc).toHaveBeenCalledTimes(2);
  });

  it('encrypts the signed response to the client key when the client asks', async () => {
    mockGetClient.mockResolvedValue({
      client_id: 'jarm-client',
      authorization_encrypted_response_alg: 'RSA-OAEP-256',
      authorization_encrypted_response_enc: 'A256GCM',
      jwks: { keys: [encryptionJwk] },
    });
    const response = await send(
      { responseMode: 'query.jwt', clientId: 'jarm-client' },
      { tenantId: 'jarm-d' }
    );
    const token = await jarmToken(response, 'query');
    expect(decodeProtectedHeader(token)).toMatchObject({
      alg: 'RSA-OAEP-256',
      enc: 'A256GCM',
      cty: 'JWT',
      kid: 'enc-1',
    });
    const { plaintext } = await compactDecrypt(token, encryptionKeys.privateKey);
    const { payload } = await jwtVerify(new TextDecoder().decode(plaintext), signingKeys.publicKey);
    expect(payload.error).toBe('access_denied');
  });

  it.each([
    ['the client is unknown', null],
    [
      'no client key fits the encryption algorithm',
      {
        authorization_encrypted_response_alg: 'ECDH-ES',
        authorization_encrypted_response_enc: 'A256GCM',
        jwks: { keys: [] as JWK[] },
      },
    ],
    [
      'the client has no key at all',
      {
        authorization_encrypted_response_alg: 'RSA-OAEP-256',
        authorization_encrypted_response_enc: 'A256GCM',
      },
    ],
    [
      'the jwks_uri is internal',
      {
        authorization_encrypted_response_alg: 'RSA-OAEP-256',
        authorization_encrypted_response_enc: 'A256GCM',
        jwks_uri: 'https://127.0.0.1/jwks',
      },
    ],
    ['the signing algorithm is not supported', { authorization_signed_response_alg: 'none' }],
  ])('answers 500 server_error when %s', async (_label, client) => {
    mockGetClient.mockResolvedValue(
      client === null ? null : { client_id: 'jarm-client', ...client }
    );
    const response = await send(
      { responseMode: 'query.jwt', clientId: 'jarm-client' },
      { tenantId: 'jarm-err' }
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: 'server_error',
      error_description: 'Failed to create JWT-secured authorization response',
    });
    expect(response.headers.get('Location')).toBeNull();
  });

  it('refuses a client algorithm outside the tenant allowed list', async () => {
    mockGetClient.mockResolvedValue({
      client_id: 'jarm-client',
      authorization_signed_response_alg: 'RS256',
    });
    const response = await send(
      {
        responseMode: 'query.jwt',
        clientId: 'jarm-client',
        messageSigning: { enabled: true, authorizationSigningAlgorithms: ['ES256'] },
      },
      { tenantId: 'jarm-alg' }
    );
    expect(response.status).toBe(500);
    expect(keyRpc).not.toHaveBeenCalled();
  });

  it('signs with the tenant default algorithm when message signing is on', async () => {
    const response = await send(
      {
        responseMode: 'query.jwt',
        clientId: 'jarm-client',
        messageSigning: {
          enabled: true,
          defaultAuthorizationSigningAlgorithm: 'RS256',
          authorizationSigningAlgorithms: ['RS256'],
        },
      },
      { tenantId: 'jarm-default-alg' }
    );
    expect(response.status).toBe(302);
    expect(keyRpc).toHaveBeenCalledWith('RS256');
  });

  it.each([
    ['no key', null],
    ['a key without kid', { privatePEM: 'x' }],
    ['a key without private PEM', { kid: 'k' }],
  ])('answers 500 when the key manager returns %s', async (_label, keyData) => {
    keyRpc.mockResolvedValue(keyData);
    const response = await send(
      { responseMode: 'query.jwt', clientId: 'jarm-client' },
      { tenantId: `jarm-key-${_label}` }
    );
    expect(response.status).toBe(500);
  });

  it('answers 500 without a KEY_MANAGER binding', async () => {
    (env as { KEY_MANAGER?: unknown }).KEY_MANAGER = undefined;
    const response = await send(
      { responseMode: 'query.jwt', clientId: 'jarm-client' },
      { tenantId: 'jarm-no-km' }
    );
    expect(response.status).toBe(500);
  });
});
