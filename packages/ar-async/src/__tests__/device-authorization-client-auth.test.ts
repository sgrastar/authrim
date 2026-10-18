/**
 * POST /device_authorization: client authentication (RFC 8628 section 3.1). A public client sends
 * its client_id only; a confidential client authenticates as it does at the token endpoint.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  JWT_BEARER,
  SECRET,
  basic,
  deviceClients,
  harness,
  registerClient,
  registerJwtClient,
  registerSecretClient,
  silentLogger,
  ISSUER,
} from './device-authorization-harness';

vi.mock('@authrim/ar-lib-core', async () => {
  const actual = await vi.importActual('@authrim/ar-lib-core');
  const shared = globalThis as unknown as {
    __deviceClients: Map<string, Record<string, unknown>>;
    __deviceLogger: unknown;
  };
  return {
    ...actual,
    getClientCached: async (_c: unknown, _env: unknown, id: string) =>
      shared.__deviceClients.get(id) ?? null,
    getLogger: () => shared.__deviceLogger,
  };
});

const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const KEYS = [
  'device_code',
  'expires_in',
  'interval',
  'user_code',
  'verification_uri',
  'verification_uri_complete',
];

beforeEach(() => {
  deviceClients.clear();
  silentLogger.warn.mockClear();
});

describe('a public client', () => {
  it('is issued a code with its client_id only, in the response shape it always had', async () => {
    await registerClient('tv', { token_endpoint_auth_method: 'none', grant_types: [DEVICE_GRANT] });
    const { response, body } = await harness().post({ client_id: 'tv' });

    expect(response.status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(KEYS);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('is refused when it registered no authentication method and no secret (legacy): the token endpoint would refuse it too', async () => {
    await registerClient('legacy-tv');
    const h = harness();
    const { response, body } = await h.post({ client_id: 'legacy-tv' });
    expect(response.status).toBe(401);
    expect(body.error).toBe('invalid_client');
    expect(h.stored).toHaveLength(0);
  });

  it('is refused when it presents a secret it was never given', async () => {
    await registerClient('tv', { token_endpoint_auth_method: 'none' });
    const h = harness();
    const { response, body } = await h.post({ client_id: 'tv', client_secret: SECRET });

    expect(response.status).toBe(401);
    expect(body.error).toBe('invalid_client');
    expect(h.stored).toHaveLength(0);
  });
});

describe('a client_secret_post client', () => {
  beforeEach(() => registerSecretClient('app', 'client_secret_post'));

  it('is issued a code with the right secret', async () => {
    const h = harness();
    const { response } = await h.post({ client_id: 'app', client_secret: SECRET });
    expect(response.status).toBe(200);
    expect(h.stored[0]).toMatchObject({ client_id: 'app' });
  });

  it.each([
    ['no secret', { client_id: 'app' }],
    ['a wrong secret', { client_id: 'app', client_secret: 'not-the-secret' }],
    ['an empty secret', { client_id: 'app', client_secret: '' }],
  ])('is refused with %s, and nothing is stored', async (_label, form) => {
    const h = harness();
    const { response, body } = await h.post(form);

    expect(response.status).toBe(401);
    expect(body).toEqual({ error: 'invalid_client', error_description: expect.any(String) });
    expect(h.stored).toHaveLength(0);
  });

  it('is refused when it authenticates by another method than it registered', async () => {
    const h = harness();
    const { response } = await h.post(
      { client_id: 'app' },
      { headers: { Authorization: basic('app', SECRET) } }
    );
    expect(response.status).toBe(401);
    expect(h.stored).toHaveLength(0);
  });
});

describe('a client_secret_basic client', () => {
  beforeEach(() => registerSecretClient('app', 'client_secret_basic'));

  it('is issued a code, with the client_id in the Authorization header only', async () => {
    const h = harness();
    const { response } = await h.post(
      { scope: 'openid' },
      { headers: { Authorization: basic('app', SECRET) } }
    );
    expect(response.status).toBe(200);
    expect(h.stored[0]).toMatchObject({ client_id: 'app', scope: 'openid' });
  });

  it.each(['basic', 'BASIC', 'bAsIc'])(
    'is issued a code when the scheme is written "%s" (RFC 9110: case-insensitive)',
    async (scheme) => {
      const h = harness();
      const { response } = await h.post(
        { scope: 'openid' },
        { headers: { Authorization: basic('app', SECRET).replace('Basic', scheme) } }
      );
      expect(response.status).toBe(200);
      expect(h.stored[0]).toMatchObject({ client_id: 'app' });
    }
  );

  it('is refused with a wrong secret under a lower-case scheme, and the challenge is sent', async () => {
    const { response } = await harness().post(
      {},
      { headers: { Authorization: basic('app', 'wrong').replace('Basic', 'basic') } }
    );
    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toMatch(/^Basic /);
  });

  it('is issued a code when the body client_id matches the header', async () => {
    const { response } = await harness().post(
      { client_id: 'app' },
      { headers: { Authorization: basic('app', SECRET) } }
    );
    expect(response.status).toBe(200);
  });

  it('is refused with a wrong secret, and the answer names the Basic scheme', async () => {
    const h = harness();
    const { response, body } = await h.post(
      { client_id: 'app' },
      { headers: { Authorization: basic('app', 'wrong') } }
    );
    expect(response.status).toBe(401);
    expect(body.error).toBe('invalid_client');
    expect(response.headers.get('WWW-Authenticate')).toMatch(/^Basic /);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(h.stored).toHaveLength(0);
  });

  it('is refused when the body names another client than the header', async () => {
    await registerSecretClient('other', 'client_secret_basic');
    const { response } = await harness().post(
      { client_id: 'other' },
      { headers: { Authorization: basic('app', SECRET) } }
    );
    expect(response.status).toBe(401);
  });

  it('is refused with no credentials, and no Basic challenge is sent to a client that sent none', async () => {
    const { response } = await harness().post({ client_id: 'app' });
    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toBeNull();
  });

  it('is refused with a malformed Authorization header', async () => {
    const { response, body } = await harness().post(
      { client_id: 'app' },
      { headers: { Authorization: 'Basic !!!not-base64!!!' } }
    );
    expect(response.status).toBe(401);
    expect(body.error).toBe('invalid_client');
  });
});

describe('a client with a secret and no registered method (legacy)', () => {
  it('still has to present the secret', async () => {
    await registerSecretClient('old', undefined);
    const h = harness();
    expect((await h.post({ client_id: 'old' })).response.status).toBe(401);
    expect((await h.post({ client_id: 'old', client_secret: SECRET })).response.status).toBe(200);
  });
});

describe('a private_key_jwt client', () => {
  const assertionForm = (assertion: string, extra: Record<string, string> = {}) => ({
    client_assertion_type: JWT_BEARER,
    client_assertion: assertion,
    ...extra,
  });

  it('is issued a code with an assertion for this endpoint, with or without client_id', async () => {
    const { assert } = await registerJwtClient('jwt-app');
    const h = harness();
    expect((await h.post(assertionForm(await assert()))).response.status).toBe(200);
    expect(
      (await h.post(assertionForm(await assert(), { client_id: 'jwt-app' }))).response.status
    ).toBe(200);
  });

  it('accepts an assertion made for the token endpoint or the issuer, as /bc-authorize does', async () => {
    const { assert } = await registerJwtClient('jwt-app');
    const h = harness();
    for (const audience of [`${ISSUER}/token`, ISSUER]) {
      const form = assertionForm(await assert({ audience }));
      expect((await h.post(form)).response.status).toBe(200);
    }
  });

  it.each([
    ['an assertion signed with another key', { wrongKey: true }],
    ['an assertion for another audience', { audience: 'https://elsewhere.example.com/token' }],
  ])('is refused with %s', async (_label, options) => {
    const { assert } = await registerJwtClient('jwt-app');
    const h = harness();
    const { response, body } = await h.post(assertionForm(await assert(options)));
    expect(response.status).toBe(401);
    expect(body.error).toBe('invalid_client');
    expect(h.stored).toHaveLength(0);
  });

  it('is refused when an assertion is replayed', async () => {
    const { assert } = await registerJwtClient('jwt-app');
    const h = harness();
    const form = assertionForm(await assert({ jti: 'same-jti' }));
    expect((await h.post(form)).response.status).toBe(200);
    expect((await h.post(form)).response.status).toBe(401);
  });

  it('is refused when it sends a secret instead of an assertion, or both', async () => {
    const { assert } = await registerJwtClient('jwt-app');
    const h = harness();
    expect((await h.post({ client_id: 'jwt-app', client_secret: SECRET })).response.status).toBe(
      401
    );
    const both = assertionForm(await assert(), { client_id: 'jwt-app', client_secret: SECRET });
    expect((await h.post(both)).response.status).toBe(401);
    expect(h.stored).toHaveLength(0);
  });
});

describe('what the refusal gives away', () => {
  it('is the same for a client that does not exist, a wrong secret and a missing secret', async () => {
    await registerSecretClient('app');
    const answers = [];
    const forms: Record<string, string>[] = [
      { client_id: 'nobody', client_secret: SECRET },
      { client_id: 'app', client_secret: 'wrong' },
      { client_id: 'app' },
    ];
    for (const form of forms) {
      const { response, body } = await harness().post(form);
      answers.push({
        status: response.status,
        body,
        challenge: response.headers.get('WWW-Authenticate'),
        cache: response.headers.get('Cache-Control'),
      });
    }
    expect(answers[0]).toEqual(answers[1]);
    expect(answers[1]).toEqual(answers[2]);
    expect(answers[0].status).toBe(401);
  });

  it('is the same with Basic credentials', async () => {
    await registerSecretClient('app', 'client_secret_basic');
    const a = await harness().post({}, { headers: { Authorization: basic('nobody', SECRET) } });
    const b = await harness().post({}, { headers: { Authorization: basic('app', 'wrong') } });
    expect(a.response.status).toBe(b.response.status);
    expect(a.body).toEqual(b.body);
    expect(a.response.headers.get('WWW-Authenticate')).toBe(
      b.response.headers.get('WWW-Authenticate')
    );
  });

  it('does not tell a client that has not authenticated whether it may use the grant', async () => {
    await registerSecretClient('no-device', 'client_secret_post', {
      grant_types: ['authorization_code'],
    });
    await registerSecretClient('device');
    const wrong = await harness().post({ client_id: 'no-device', client_secret: 'wrong' });
    const unknown = await harness().post({ client_id: 'nobody', client_secret: 'wrong' });
    expect(wrong.response.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);

    // Once authenticated, it is told
    const told = await harness().post({ client_id: 'no-device', client_secret: SECRET });
    expect(told.response.status).toBe(400);
    expect(told.body.error).toBe('unauthorized_client');
  });

  it('logs a failed authentication without the credentials', async () => {
    await registerSecretClient('app');
    await harness().post({ client_id: 'app', client_secret: 'very-wrong-secret' });
    const logged = JSON.stringify(silentLogger.warn.mock.calls);
    expect(logged).toContain('app');
    expect(logged).not.toContain('very-wrong-secret');
  });
});

/**
 * The device_code grant of the token endpoint (packages/ar-token) takes only a client registered
 * with `none` as public. The same table is in ar-token's client-auth test, driven through the
 * token endpoint: a client is issued a code here exactly when it can redeem it there.
 */
describe('which clients are public: the table the token endpoint checks too', () => {
  const secretHash = 'a-secret-hash';
  const TABLE: Array<[string, Record<string, unknown>, boolean]> = [
    ['none', { token_endpoint_auth_method: 'none' }, true],
    [
      'none with a leftover secret',
      { token_endpoint_auth_method: 'none', client_secret_hash: secretHash },
      true,
    ],
    [
      'client_secret_basic',
      { token_endpoint_auth_method: 'client_secret_basic', client_secret_hash: secretHash },
      false,
    ],
    [
      'client_secret_post',
      { token_endpoint_auth_method: 'client_secret_post', client_secret_hash: secretHash },
      false,
    ],
    [
      'private_key_jwt',
      { token_endpoint_auth_method: 'private_key_jwt', jwks: { keys: [] } },
      false,
    ],
    ['legacy: no method, no secret', {}, false],
    ['legacy: no method, with a secret', { client_secret_hash: secretHash }, false],
  ];

  it.each(TABLE)('%s: issued with the client_id only = %s', async (_label, metadata, public_) => {
    await registerClient('kind', { grant_types: [DEVICE_GRANT], ...metadata });
    const h = harness();
    const { response } = await h.post({ client_id: 'kind' });
    expect(response.status).toBe(public_ ? 200 : 401);
    expect(h.stored).toHaveLength(public_ ? 1 : 0);
  });

  it('is decided by the one function the token endpoint uses', async () => {
    const { isDeviceCodePublicClient } = await import('@authrim/ar-lib-core');
    for (const [, metadata, public_] of TABLE) {
      expect(isDeviceCodePublicClient(metadata as never)).toBe(public_);
    }
  });
});
