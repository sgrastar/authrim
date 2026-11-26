/**
 * VCI token endpoint: each refusal with its error and description, the reserve/complete/release
 * protocol with the offer store, and the token lifetime arithmetic.
 */

import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../../types';

const h = vi.hoisted(() => {
  const logger = { module: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() };
  logger.module.mockReturnValue(logger);
  return {
    logger,
    resolveEffectiveSettings: vi.fn(),
    falDpop: vi.fn(),
    falSigned: vi.fn(),
    parseCode: vi.fn(),
    offerStore: vi.fn(),
    isConfiguredShard: vi.fn(),
    hashTx: vi.fn(),
    sha: vi.fn(),
  };
});

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getLogger: () => h.logger,
    getTenantIdFromContext: () => 'tenant-1',
    resolveEffectiveSettings: h.resolveEffectiveSettings,
    falRequiresDpop: h.falDpop,
    falRequiresSignedPushedRequest: h.falSigned,
  };
});
vi.mock('../../../utils/configured-shard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../utils/configured-shard')>()),
  isConfiguredShard: h.isConfiguredShard,
}));
vi.mock('../../../utils/credential-offer-sharding', () => ({
  parsePreAuthorizedCode: h.parseCode,
  getCredentialOfferStoreById: h.offerStore,
}));
vi.mock('../../../utils/crypto', () => ({
  hashTransactionCode: h.hashTx,
  sha256Base64url: h.sha,
}));
vi.mock('../../../request-identifiers', () => ({
  getRequestIssuerUrl: () => 'https://issuer.example.com',
}));

import { ShardConfigUnavailableError } from '../../../utils/configured-shard';
import { generateVCIAccessToken, resolveAccessTokenTtlSeconds, vciTokenRoute } from '../token';

const NOW_MS = 1_800_000_000_000;
const GRANT = 'urn:ietf:params:oauth:grant-type:pre-authorized_code';
const FORM = 'application/x-www-form-urlencoded';

let stub: { fetch: ReturnType<typeof vi.fn<(request: Request) => Promise<unknown>>> };
let sign: ReturnType<typeof vi.fn>;
let env: Env;
let idFromName: ReturnType<typeof vi.fn<(name: string) => string>>;
let offerExpiresAt: number;

const answer = (body: unknown, ok = true) =>
  new Response(JSON.stringify(body), { status: ok ? 200 : 500 });
const calls = (path: string) =>
  stub.fetch.mock.calls.filter((call) => new URL((call[0] as Request).url).pathname === path);
const bodyOf = async (call: unknown[]) => (await (call[0] as Request).clone().json()) as unknown;

function routes(overrides: Record<string, () => Response> = {}) {
  const table: Record<string, () => Response> = {
    '/reserve': () =>
      answer({
        reserved: true,
        reservationId: 'res-1',
        offer: {
          userId: 'user-1',
          tenantId: 'tenant-1',
          credentialConfigurationId: 'AuthrimIdentityCredential',
          claims: {},
          expiresAt: offerExpiresAt,
        },
      }),
    '/complete': () => answer({ completed: true }),
    '/release': () => answer({ released: true }),
    ...overrides,
  };
  stub.fetch.mockImplementation(async (request: Request) => table[new URL(request.url).pathname]());
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW_MS);
  vi.resetAllMocks();
  h.logger.module.mockReturnValue(h.logger);
  h.resolveEffectiveSettings.mockResolvedValue({});
  h.falDpop.mockReturnValue(false);
  h.falSigned.mockReturnValue(false);
  h.parseCode.mockReturnValue({ offerId: 'offer-1' });
  h.isConfiguredShard.mockResolvedValue(true);
  h.hashTx.mockResolvedValue('tx-hash');
  h.sha.mockResolvedValue('code-hash');
  offerExpiresAt = NOW_MS + 10 * 60_000;
  stub = { fetch: vi.fn<(request: Request) => Promise<unknown>>() };
  routes();
  h.offerStore.mockReturnValue({ stub, resolution: 'r' });
  sign = vi.fn(async () => ({ token: 'signed.access.token' }));
  idFromName = vi.fn((name: string) => `id:${name}`);
  env = {
    VC_TRANSACTION_CODE_HMAC_SECRET: 'secret',
    KEY_MANAGER: {
      idFromName,
      get: () => ({ signVCIAccessTokenRpc: sign }),
    },
  } as unknown as Env;
});
afterEach(() => {
  vi.useRealTimers();
});

async function post(
  form: Record<string, string> = { grant_type: GRANT, 'pre-authorized_code': 'code-1' },
  contentType: string | null = FORM
) {
  const app = new Hono<{ Bindings: Env }>();
  app.post('/vci/token', vciTokenRoute);
  const response = await app.request(
    'https://issuer.example.com/vci/token',
    {
      method: 'POST',
      headers: contentType === null ? {} : { 'Content-Type': contentType },
      body: new URLSearchParams(form).toString(),
    },
    env
  );
  return { status: response.status, body: await response.json(), headers: response.headers };
}
const rejected = (error: string, description?: string) =>
  description ? { error, error_description: description } : { error };

describe('vciTokenRoute: request shape', () => {
  it('names its logger module', async () => {
    await post();
    expect(h.logger.module).toHaveBeenCalledWith('VC-ISSUER');
  });

  it('requires a form-encoded body, also with a charset', async () => {
    expect(await post(undefined, 'application/json')).toMatchObject({
      status: 400,
      body: rejected('invalid_request', 'Expected application/x-www-form-urlencoded'),
    });
    expect((await post(undefined, null)).status).toBe(400);
    expect((await post(undefined, `${FORM}; charset=UTF-8`)).status).toBe(200);
  });

  it('requires a grant_type and only the pre-authorized code grant', async () => {
    expect(await post({ 'pre-authorized_code': 'c' })).toMatchObject({
      status: 400,
      body: rejected('invalid_request', 'grant_type is required'),
    });
    expect((await post({ grant_type: '', 'pre-authorized_code': 'c' })).body).toEqual(
      rejected('invalid_request', 'grant_type is required')
    );
    expect(
      await post({ grant_type: 'authorization_code', 'pre-authorized_code': 'c' })
    ).toMatchObject({
      status: 400,
      body: rejected('unsupported_grant_type'),
    });
  });

  it('refuses authorization_details, which would oblige credential_identifiers', async () => {
    expect(
      await post({ grant_type: GRANT, 'pre-authorized_code': 'c', authorization_details: '[]' })
    ).toMatchObject({
      status: 400,
      body: rejected(
        'invalid_authorization_details',
        'authorization_details is not supported for the pre-authorized code grant'
      ),
    });
  });

  async function multipart(parts: Array<{ name: string; value: string; file?: boolean }>) {
    const boundary = 'b';
    const body =
      parts
        .map((part) =>
          [
            `--${boundary}`,
            `Content-Disposition: form-data; name="${part.name}"${part.file ? '; filename="x.txt"' : ''}`,
            ...(part.file ? ['Content-Type: text/plain'] : []),
            '',
            part.value,
          ].join('\r\n')
        )
        .join('\r\n') + `\r\n--${boundary}--\r\n`;
    const app = new Hono<{ Bindings: Env }>();
    app.post('/vci/token', vciTokenRoute);
    const response = await app.request(
      'https://issuer.example.com/vci/token',
      {
        method: 'POST',
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}; x=${FORM}` },
        body,
      },
      env
    );
    return { status: response.status, body: await response.json() };
  }

  it('refuses a grant_type that is not a plain value', async () => {
    expect(
      await multipart([
        { name: 'grant_type', value: GRANT, file: true },
        { name: 'pre-authorized_code', value: 'c' },
      ])
    ).toEqual({ status: 400, body: rejected('invalid_request', 'grant_type is required') });
  });

  it('refuses a tx_code that is not a single value', async () => {
    // A content type that mentions the form type but carries multipart makes parseBody return a File.
    const boundary = 'b';
    const body = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="grant_type"',
      '',
      GRANT,
      `--${boundary}`,
      'Content-Disposition: form-data; name="pre-authorized_code"',
      '',
      'code-1',
      `--${boundary}`,
      'Content-Disposition: form-data; name="tx_code"; filename="x.txt"',
      'Content-Type: text/plain',
      '',
      '1234',
      `--${boundary}--`,
      '',
    ].join('\r\n');
    const app = new Hono<{ Bindings: Env }>();
    app.post('/vci/token', vciTokenRoute);
    const response = await app.request(
      'https://issuer.example.com/vci/token',
      {
        method: 'POST',
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}; x=${FORM}` },
        body,
      },
      env
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual(
      rejected('invalid_request', 'tx_code must be a single value')
    );
    expect(stub.fetch).not.toHaveBeenCalled();
  });

  it('requires the pre-authorized code', async () => {
    for (const form of [
      { grant_type: GRANT } as Record<string, string>,
      { grant_type: GRANT, 'pre-authorized_code': '' },
    ]) {
      expect(await post(form)).toMatchObject({
        status: 400,
        body: rejected('invalid_request', 'pre-authorized_code is required'),
      });
    }
  });
});

describe('vciTokenRoute: assurance', () => {
  it('reads the assurance settings of the tenant', async () => {
    await post();
    expect(h.resolveEffectiveSettings).toHaveBeenCalledWith(env, 'assurance', {
      tenantId: 'tenant-1',
    });
  });

  it('answers 503 when the settings cannot be read', async () => {
    h.resolveEffectiveSettings.mockRejectedValue(new Error('kv down'));
    expect(await post()).toMatchObject({
      status: 503,
      body: rejected('temporarily_unavailable', 'Assurance settings are temporarily unavailable'),
    });
    expect(h.logger.error).toHaveBeenCalledWith(
      'Failed to load assurance settings',
      { action: 'assurance_settings' },
      expect.objectContaining({ message: 'kv down' })
    );
    expect(stub.fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['DPoP', () => h.falDpop.mockReturnValue(true)],
    ['a signed pushed request', () => h.falSigned.mockReturnValue(true)],
  ])(
    'refuses the grant when the level requires %s, before reserving the offer',
    async (_n, set) => {
      set();
      expect(await post()).toMatchObject({
        status: 400,
        body: rejected(
          'unauthorized_client',
          'A pre-authorized code grant does not meet the required federation assurance level'
        ),
      });
      expect(stub.fetch).not.toHaveBeenCalled();
    }
  );
});

describe('vciTokenRoute: reserving the offer', () => {
  it('reserves with the code hash, the tx code hash and the clock', async () => {
    await post({ grant_type: GRANT, 'pre-authorized_code': 'code-1', tx_code: '1234' });
    expect(h.parseCode).toHaveBeenCalledWith('code-1');
    expect(h.offerStore).toHaveBeenCalledWith(env, 'offer-1', 'tenant-1');
    expect(h.sha).toHaveBeenCalledWith('code-1');
    expect(h.hashTx).toHaveBeenCalledWith('secret', 'tenant-1', 'offer-1', '1234');
    expect(await bodyOf(calls('/reserve')[0])).toEqual({
      id: 'offer-1',
      tenantId: 'tenant-1',
      preAuthorizedCodeHash: 'code-hash',
      txCodeHash: 'tx-hash',
      now: NOW_MS,
    });
  });

  it('speaks JSON to the offer store on every call', async () => {
    await post();
    for (const path of ['/reserve', '/complete']) {
      expect((calls(path)[0][0] as Request).headers.get('Content-Type')).toBe('application/json');
    }
    sign.mockRejectedValue(new Error('km down'));
    await post();
    expect((calls('/release')[0][0] as Request).headers.get('Content-Type')).toBe(
      'application/json'
    );
  });

  it('trusts no answer of a store that reported a failure', async () => {
    routes({
      '/reserve': () =>
        answer(
          {
            reserved: true,
            reservationId: 'res-1',
            offer: {
              userId: 'u',
              tenantId: 't',
              credentialConfigurationId: 'c',
              claims: {},
              expiresAt: offerExpiresAt,
            },
          },
          false
        ),
    });
    expect(await post()).toMatchObject({ status: 400, body: rejected('invalid_grant') });
    routes({ '/complete': () => answer({ completed: true }, false) });
    expect(await post()).toMatchObject({ status: 500, body: rejected('server_error') });
  });

  it('sends no tx code hash without a tx code', async () => {
    await post();
    expect(h.hashTx).not.toHaveBeenCalled();
    expect(
      ((await bodyOf(calls('/reserve')[0])) as Record<string, unknown>).txCodeHash
    ).toBeUndefined();
  });

  it.each([
    ['an unparsable code', () => h.parseCode.mockReturnValue(null)],
    ['a shard that is not configured', () => h.isConfiguredShard.mockResolvedValue(false)],
    ['a refusing store', () => routes({ '/reserve': () => answer({}, false) })],
    [
      'a store without reservation',
      () => routes({ '/reserve': () => answer({ reserved: false }) }),
    ],
    [
      'a reservation without id',
      () => routes({ '/reserve': () => answer({ reserved: true, offer: {} }) }),
    ],
    [
      'a reservation without offer',
      () => routes({ '/reserve': () => answer({ reserved: true, reservationId: 'r' }) }),
    ],
  ])('answers invalid_grant for %s', async (_name, set) => {
    set();
    expect(await post()).toMatchObject({ status: 400, body: rejected('invalid_grant') });
    expect(calls('/complete')).toHaveLength(0);
  });

  it('answers invalid_grant and logs when the store throws', async () => {
    stub.fetch.mockRejectedValue(new Error('network'));
    expect(await post()).toMatchObject({ status: 400, body: rejected('invalid_grant') });
    expect(h.logger.error).toHaveBeenCalledWith(
      'Failed to reserve offer by code',
      {},
      expect.objectContaining({ message: 'network' })
    );
  });

  it('answers 503 when the shard configuration cannot be read', async () => {
    h.isConfiguredShard.mockRejectedValue(new ShardConfigUnavailableError('kv'));
    expect(await post()).toMatchObject({ status: 503, body: rejected('temporarily_unavailable') });
  });

  it.each(['tx_code_required', 'tx_code_not_expected'])(
    'reports %s as a malformed tx_code',
    async (reason) => {
      routes({ '/reserve': () => answer({ reserved: false, reason }) });
      expect(await post()).toMatchObject({
        status: 400,
        body: rejected(
          'invalid_request',
          'tx_code must be sent exactly when the credential offer requires it'
        ),
      });
    }
  );
});

describe('vciTokenRoute: the token', () => {
  it('signs for the pre-authorized AS and returns the bearer token without caching', async () => {
    const result = await post();
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      access_token: 'signed.access.token',
      token_type: 'Bearer',
      expires_in: 300,
    });
    expect(result.headers.get('Cache-Control')).toBe('no-store');
    expect(result.headers.get('Pragma')).toBe('no-cache');
    expect(sign).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      userId: 'user-1',
      offerId: 'offer-1',
      credentialConfigurationId: 'AuthrimIdentityCredential',
      issuer: 'https://issuer.example.com/vci',
      audience: 'https://issuer.example.com',
      expiresInSeconds: 300,
    });
  });

  it('keeps the offer state only as long as the token lives', async () => {
    await post();
    expect(await bodyOf(calls('/complete')[0])).toEqual({
      id: 'offer-1',
      tenantId: 'tenant-1',
      reservationId: 'res-1',
      claimsExpiresAt: NOW_MS + 300_000,
    });
    expect(calls('/release')).toHaveLength(0);
  });

  it('shortens the token to the offer expiry plus a minute', async () => {
    offerExpiresAt = NOW_MS + 30_000;
    const result = await post();
    expect(result.body).toMatchObject({ expires_in: 90 });
    expect(await bodyOf(calls('/complete')[0])).toMatchObject({ claimsExpiresAt: NOW_MS + 90_000 });
  });

  it('releases the reservation and answers 500 when signing fails', async () => {
    sign.mockRejectedValue(new Error('km down'));
    expect(await post()).toMatchObject({ status: 500, body: rejected('server_error') });
    expect(await bodyOf(calls('/release')[0])).toEqual({
      id: 'offer-1',
      tenantId: 'tenant-1',
      reservationId: 'res-1',
    });
    expect(calls('/complete')).toHaveLength(0);
  });

  it.each([
    ['a refusing store', () => answer({}, false)],
    ['an incomplete answer', () => answer({ completed: false })],
    ['a non-boolean answer', () => answer({ completed: 'yes' })],
  ])('releases the reservation and answers 500 for %s on completion', async (_n, response) => {
    routes({ '/complete': response });
    expect(await post()).toMatchObject({ status: 500, body: rejected('server_error') });
    expect(calls('/release')).toHaveLength(1);
    expect(h.logger.error).toHaveBeenCalledWith(
      'VCI token request failed',
      {},
      expect.objectContaining({ message: 'Credential offer reservation completion failed' })
    );
  });

  it('logs a release that fails and still answers 500', async () => {
    sign.mockRejectedValue(new Error('km down'));
    stub.fetch.mockImplementation(async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (path === '/release') throw new Error('gone');
      return path === '/reserve'
        ? answer({
            reserved: true,
            reservationId: 'res-1',
            offer: {
              userId: 'u',
              tenantId: 't',
              credentialConfigurationId: 'c',
              claims: {},
              expiresAt: offerExpiresAt,
            },
          })
        : answer({});
    });
    expect((await post()).status).toBe(500);
    expect(h.logger.error).toHaveBeenCalledWith(
      'Failed to release credential offer reservation',
      {},
      expect.objectContaining({ message: 'gone' })
    );
  });

  it.each([
    ['an empty token', ''],
    ['a non-string token', 12345],
  ])('answers 500 and releases the offer exactly once for %s', async (_name, token) => {
    sign.mockResolvedValue({ token });
    expect(await post()).toMatchObject({ status: 500, body: rejected('server_error') });
    expect(h.logger.error).toHaveBeenCalledWith(
      'VCI token request failed',
      {},
      expect.objectContaining({ message: 'access_token must be a non-empty string' })
    );
    // The invalid result never consumes the offer: it is released, not completed.
    expect(calls('/complete')).toHaveLength(0);
    expect(calls('/release')).toHaveLength(1);
  });

  it.each([
    ['an HTTP error', () => answer({}, false)],
    ['released false', () => answer({ released: false })],
    ['a non-boolean answer', () => answer({ released: 'yes' })],
  ])('logs a release the store did not confirm (%s) and still answers 500', async (_n, release) => {
    sign.mockRejectedValue(new Error('km down'));
    routes({ '/release': release });
    expect(await post()).toMatchObject({ status: 500, body: rejected('server_error') });
    expect(calls('/release')).toHaveLength(1);
    expect(h.logger.error).toHaveBeenCalledWith(
      'Credential offer reservation was not released',
      expect.objectContaining({ offerId: 'offer-1' })
    );
  });

  it('does not log a release failure when the store confirms the release', async () => {
    sign.mockRejectedValue(new Error('km down'));
    await post();
    expect(h.logger.error).not.toHaveBeenCalledWith(
      'Credential offer reservation was not released',
      expect.anything()
    );
  });

  it('signs with the key manager of the tenant of the offer', async () => {
    await post();
    expect(idFromName).toHaveBeenCalledWith('tenant-1-v3');
  });
});

describe('resolveAccessTokenTtlSeconds and generateVCIAccessToken', () => {
  it('is the offer expiry plus a minute, within one to five minutes', () => {
    expect(resolveAccessTokenTtlSeconds(NOW_MS + 10_000, NOW_MS)).toBe(70);
    expect(resolveAccessTokenTtlSeconds(NOW_MS + 10_999, NOW_MS)).toBe(70);
    expect(resolveAccessTokenTtlSeconds(NOW_MS + 240_000, NOW_MS)).toBe(300);
    expect(resolveAccessTokenTtlSeconds(NOW_MS + 239_000, NOW_MS)).toBe(299);
    expect(resolveAccessTokenTtlSeconds(NOW_MS + 3_600_000, NOW_MS)).toBe(300);
    expect(resolveAccessTokenTtlSeconds(NOW_MS - 3_600_000, NOW_MS)).toBe(60);
    expect(resolveAccessTokenTtlSeconds(NOW_MS, NOW_MS)).toBe(60);
  });

  it('falls back to the minimum for an offer expiry that is not a number', () => {
    expect(resolveAccessTokenTtlSeconds(Number.NaN, NOW_MS)).toBe(60);
    expect(resolveAccessTokenTtlSeconds(Number.POSITIVE_INFINITY, NOW_MS)).toBe(60);
  });

  it('asks the tenant key manager to sign for the issuer and audience', async () => {
    const token = await generateVCIAccessToken(
      env,
      { userId: 'u', tenantId: 'tenant-9', credentialConfigurationId: 'cfg', offerId: 'o' },
      { credentialIssuer: 'https://i.example', expiresInSeconds: 120 }
    );
    expect(token).toBe('signed.access.token');
    expect(sign).toHaveBeenCalledWith({
      tenantId: 'tenant-9',
      userId: 'u',
      offerId: 'o',
      credentialConfigurationId: 'cfg',
      issuer: 'https://i.example/vci',
      audience: 'https://i.example',
      expiresInSeconds: 120,
    });
  });
});
