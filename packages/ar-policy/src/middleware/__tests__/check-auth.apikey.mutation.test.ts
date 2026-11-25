/**
 * Check API authentication: API key, header parsing and tenant resolution
 * (mutation-hardening tests; every failure is asserted in full).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  authenticateCheckApiRequest,
  isOperationAllowed,
  resolveAuthorizedCheckTenantId,
  RATE_LIMIT_CONFIG,
  type CheckAuthContext,
  type CheckAuthResult,
} from '../check-auth';
import { fakeAdapter, fakeKv, keyRow, must, sha256Hex } from './check-auth-mutation-helpers';

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    createLogger: () => ({
      module: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
    }),
  };
});

const NOW_SECONDS = 1_800_000_000;
const API_KEY = 'chk_abcdef0123456789';

function failure(error: string, errorDescription: string, statusCode: number): CheckAuthResult {
  return { authenticated: false, error, errorDescription, statusCode };
}

async function authenticate(
  token: string,
  ctx: Partial<CheckAuthContext> = {}
): Promise<CheckAuthResult> {
  return authenticateCheckApiRequest(`Bearer ${token}`, {
    db: fakeAdapter([]).adapter,
    ...ctx,
  });
}

describe('check-auth: API key lookup', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_SECONDS * 1000));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('looks the key up by its 8-character prefix and returns the stored grant', async () => {
    const { adapter, query } = fakeAdapter([await keyRow(API_KEY)]);

    const result = await authenticate(API_KEY, { db: adapter });

    expect(result).toEqual({
      authenticated: true,
      method: 'api_key',
      apiKeyId: 'key_1',
      clientId: 'client_a',
      tenantId: 'tenant_a',
      rateLimitTier: 'strict',
      allowedOperations: ['check', 'subscribe'],
    });
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = must(query.mock.calls[0]);
    expect(sql).toContain('FROM check_api_keys');
    expect(sql).toContain('WHERE key_prefix = ?');
    expect(params).toEqual(['chk_abcd']);
  });

  it('rejects an unknown key', async () => {
    const other = await keyRow('chk_abcdXXXXXXXXXXXX');
    const { adapter } = fakeAdapter([other]);

    expect(await authenticate(API_KEY, { db: adapter })).toEqual(
      failure('invalid_token', 'Invalid API key', 401)
    );
  });

  it('rejects an inactive key', async () => {
    const { adapter } = fakeAdapter([await keyRow(API_KEY, { is_active: 0 })]);

    expect(await authenticate(API_KEY, { db: adapter })).toEqual(
      failure('invalid_token', 'API key is inactive', 401)
    );
  });

  it('rejects an expired key and accepts one that expires exactly now', async () => {
    const expired = fakeAdapter([await keyRow(API_KEY, { expires_at: NOW_SECONDS - 1 })]);
    expect(await authenticate(API_KEY, { db: expired.adapter })).toEqual(
      failure('invalid_token', 'API key has expired', 401)
    );

    const lastSecond = fakeAdapter([await keyRow(API_KEY, { expires_at: NOW_SECONDS })]);
    expect((await authenticate(API_KEY, { db: lastSecond.adapter })).authenticated).toBe(true);
  });

  it('accepts a key that expires in the future (expiry is compared in seconds)', async () => {
    const { adapter } = fakeAdapter([await keyRow(API_KEY, { expires_at: NOW_SECONDS + 3600 })]);
    expect((await authenticate(API_KEY, { db: adapter })).authenticated).toBe(true);
  });

  it('reports a database failure as a server error', async () => {
    const { adapter } = fakeAdapter([], new Error('db down'));

    expect(await authenticate(API_KEY, { db: adapter })).toEqual(
      failure('server_error', 'API key validation failed', 500)
    );
  });

  it('checks the hash of a later row with the same prefix', async () => {
    const decoy = await keyRow('chk_abcdZZZZZZZZZZZZ', { id: 'decoy', is_active: 0 });
    const real = await keyRow(API_KEY);
    const { adapter } = fakeAdapter([decoy, real]);

    const result = await authenticate(API_KEY, { db: adapter });
    expect(result.apiKeyId).toBe('key_1');
  });
});

describe('check-auth: API key cache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_SECONDS * 1000));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('caches a validated key for five minutes under its hash', async () => {
    const row = await keyRow(API_KEY, { expires_at: NOW_SECONDS + 100 });
    const { adapter } = fakeAdapter([row]);
    const kv = fakeKv();

    await authenticate(API_KEY, { db: adapter, cache: kv.cache });

    const hash = await sha256Hex(API_KEY);
    expect(kv.put).toHaveBeenCalledTimes(1);
    const [cacheKey, value, options] = must(kv.put.mock.calls[0]);
    expect(cacheKey).toBe(`check:apikey:${hash}`);
    expect(options).toEqual({ expirationTtl: 300 });
    expect(JSON.parse(value)).toEqual({
      id: 'key_1',
      tenant_id: 'tenant_a',
      client_id: 'client_a',
      name: 'Test key',
      key_hash: hash,
      key_prefix: 'chk_abcd',
      allowed_operations: ['check', 'subscribe'],
      rate_limit_tier: 'strict',
      is_active: true,
      expires_at: NOW_SECONDS + 100,
      created_at: 1_700_000_000,
      updated_at: 1_700_000_100,
    });
  });

  it('serves a cached key without touching the database', async () => {
    const row = await keyRow(API_KEY, { expires_at: NOW_SECONDS + 100 });
    const first = fakeAdapter([row]);
    const kv = fakeKv();
    await authenticate(API_KEY, { db: first.adapter, cache: kv.cache });

    const second = fakeAdapter([]);
    const result = await authenticate(API_KEY, { db: second.adapter, cache: kv.cache });

    expect(result).toMatchObject({ authenticated: true, apiKeyId: 'key_1', tenantId: 'tenant_a' });
    expect(second.query).not.toHaveBeenCalled();
  });

  async function cachedEntry(overrides: Record<string, unknown>) {
    const hash = await sha256Hex(API_KEY);
    const store = new Map<string, string>();
    store.set(
      `check:apikey:${hash}`,
      JSON.stringify({
        id: 'key_1',
        tenant_id: 'tenant_a',
        client_id: 'client_a',
        name: 'Test key',
        key_hash: hash,
        key_prefix: 'chk_abcd',
        allowed_operations: ['check'],
        rate_limit_tier: 'lenient',
        is_active: true,
        created_at: 1,
        updated_at: 2,
        ...overrides,
      })
    );
    return fakeKv(store);
  }

  it('rejects a cached entry whose hash does not match', async () => {
    const kv = await cachedEntry({ key_hash: 'not-the-hash' });
    const { adapter, query } = fakeAdapter([await keyRow(API_KEY)]);

    expect(await authenticate(API_KEY, { db: adapter, cache: kv.cache })).toEqual(
      failure('invalid_token', 'Invalid API key', 401)
    );
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects a cached inactive entry', async () => {
    const kv = await cachedEntry({ is_active: false });
    expect(await authenticate(API_KEY, { cache: kv.cache })).toEqual(
      failure('invalid_token', 'API key is inactive', 401)
    );
  });

  it('rejects a cached expired entry and accepts one expiring now or later', async () => {
    const expired = await cachedEntry({ expires_at: NOW_SECONDS - 1 });
    expect(await authenticate(API_KEY, { cache: expired.cache })).toEqual(
      failure('invalid_token', 'API key has expired', 401)
    );

    const now = await cachedEntry({ expires_at: NOW_SECONDS });
    expect((await authenticate(API_KEY, { cache: now.cache })).authenticated).toBe(true);

    const later = await cachedEntry({ expires_at: NOW_SECONDS + 3600 });
    expect((await authenticate(API_KEY, { cache: later.cache })).authenticated).toBe(true);

    const never = await cachedEntry({});
    expect((await authenticate(API_KEY, { cache: never.cache })).authenticated).toBe(true);
  });

  it('falls back to the database when the cache cannot be read or written', async () => {
    const { adapter, query } = fakeAdapter([await keyRow(API_KEY)]);
    const unreadable = fakeKv(new Map(), { failGet: true });
    expect(
      (await authenticate(API_KEY, { db: adapter, cache: unreadable.cache })).authenticated
    ).toBe(true);
    expect(query).toHaveBeenCalledTimes(1);

    const unwritable = fakeKv(new Map(), { failPut: true });
    expect(
      (await authenticate(API_KEY, { db: adapter, cache: unwritable.cache })).authenticated
    ).toBe(true);
  });
});

describe('check-auth: header and token shape', () => {
  it('requires an Authorization header', async () => {
    const ctx = { db: fakeAdapter([]).adapter };
    expect(await authenticateCheckApiRequest(undefined, ctx)).toEqual(
      failure('invalid_token', 'Authorization header is required', 401)
    );
    expect(await authenticateCheckApiRequest('', ctx)).toEqual(
      failure('invalid_token', 'Authorization header is required', 401)
    );
  });

  it('requires the Bearer scheme', async () => {
    const ctx = { db: fakeAdapter([]).adapter };
    const expected = failure('invalid_request', 'Authorization header must use Bearer scheme', 400);
    expect(await authenticateCheckApiRequest('Basic abc', ctx)).toEqual(expected);
    expect(await authenticateCheckApiRequest('bearer chk_abc', ctx)).toEqual(expected);
    expect(await authenticateCheckApiRequest('Bearer', ctx)).toEqual(expected);
  });

  it('rejects an empty bearer token', async () => {
    expect(await authenticateCheckApiRequest('Bearer ', { db: fakeAdapter([]).adapter })).toEqual(
      failure('invalid_request', 'Bearer token is missing', 400)
    );
  });

  it.each(['a.b.c!', '!a.b.c', 'ok.ok.!!!', 'ok.!!!.ok', 'a..c', 'a.b', 'a.b.c.d', 'plain'])(
    'does not treat %s as a JWT or an API key',
    async (token) => {
      expect(await authenticate(token, { policyApiSecret: 'other-secret' })).toEqual(
        failure(
          'invalid_request',
          'Token format not recognized. Use API key (chk_xxx) or access token (JWT)',
          400
        )
      );
    }
  );

  it('treats base64url parts as a JWT (and refuses it while verification is not configured)', async () => {
    expect(await authenticate('aB_-9.cD_-9.eF_-9')).toEqual(
      failure('invalid_token', 'Access token verification is not configured', 401)
    );
  });
});

describe('check-auth: policy secret', () => {
  it('grants the internal operations at the lenient tier', async () => {
    expect(await authenticate('shared-secret', { policyApiSecret: 'shared-secret' })).toEqual({
      authenticated: true,
      method: 'policy_secret',
      rateLimitTier: 'lenient',
      allowedOperations: ['check', 'batch', 'subscribe'],
    });
  });

  it('refuses a wrong or unconfigured secret', async () => {
    const unrecognised = failure(
      'invalid_request',
      'Token format not recognized. Use API key (chk_xxx) or access token (JWT)',
      400
    );
    expect(await authenticate('wrong-secret', { policyApiSecret: 'shared-secret' })).toEqual(
      unrecognised
    );
    expect(await authenticate('shared-secret')).toEqual(unrecognised);
    expect(await authenticate('shared-secret', { policyApiSecret: '' })).toEqual(unrecognised);
  });
});

describe('check-auth: operations, tenants and tiers', () => {
  it('allows only listed operations of an authenticated caller', () => {
    const auth: CheckAuthResult = { authenticated: true, allowedOperations: ['check'] };
    expect(isOperationAllowed(auth, 'check')).toBe(true);
    expect(isOperationAllowed(auth, 'batch')).toBe(false);
    expect(isOperationAllowed({ ...auth, authenticated: false }, 'check')).toBe(false);
    expect(isOperationAllowed({ authenticated: true }, 'check')).toBe(false);
  });

  it('trims the requested and the authenticated tenant', () => {
    const token: CheckAuthResult = {
      authenticated: true,
      method: 'access_token',
      tenantId: ' tenant_a ',
    };
    expect(resolveAuthorizedCheckTenantId(token, undefined)).toBe('tenant_a');
    expect(resolveAuthorizedCheckTenantId(token, ' tenant_a ')).toBe('tenant_a');
    expect(resolveAuthorizedCheckTenantId(token, 'tenant_b')).toBeNull();
    expect(resolveAuthorizedCheckTenantId(token, '   ')).toBe('tenant_a');
    expect(
      resolveAuthorizedCheckTenantId({ authenticated: true, method: 'api_key' }, 'tenant_a')
    ).toBeNull();
    expect(
      resolveAuthorizedCheckTenantId(
        { authenticated: true, method: 'api_key', tenantId: '  ' },
        undefined
      )
    ).toBeNull();
  });

  it('lets the policy secret name any tenant, trimmed, but requires one', () => {
    const secret: CheckAuthResult = { authenticated: true, method: 'policy_secret' };
    expect(resolveAuthorizedCheckTenantId(secret, '  tenant_z  ')).toBe('tenant_z');
    expect(resolveAuthorizedCheckTenantId(secret, '   ')).toBeNull();
    expect(resolveAuthorizedCheckTenantId(secret, undefined)).toBeNull();
  });

  it('publishes the per-minute limit of each tier', () => {
    expect(RATE_LIMIT_CONFIG).toEqual({
      strict: { requests: 100, windowMs: 60000 },
      moderate: { requests: 500, windowMs: 60000 },
      lenient: { requests: 2000, windowMs: 60000 },
    });
  });
});
