import { describe, expect, it, vi } from 'vitest';
import { BuiltinPolicyInfra } from '../infra/policy/builtin';
import type { IStorageInfra, InfraEnv } from '../infra/types';

const request = { subject: 'user:alice', relation: 'viewer', object: 'document:report' };
const cacheKey = 'rebac:user:alice#viewer@document:report';

function storage(options: { direct?: boolean; inherited?: boolean } = {}) {
  const queryOne = vi.fn(async (sql: string) => {
    if (sql.includes('SELECT COUNT(*)')) return { count: options.direct ? 1 : 0 };
    if (sql.includes('WITH RECURSIVE')) return options.inherited ? { found: 1 } : null;
    throw new Error('unexpected query');
  });
  const query = vi.fn(async () => []);
  return { adapter: { queryOne, query } } as unknown as IStorageInfra & {
    adapter: { queryOne: typeof queryOne; query: typeof query };
  };
}

function memoryCache(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    get: vi.fn(async (key: string) => values.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      values.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      values.delete(key);
    }),
  } as unknown as KVNamespace & { values: Map<string, string> };
}

describe('BuiltinPolicyInfra relationship checks', () => {
  it('requires initialization before serving authorization decisions', async () => {
    const policy = new BuiltinPolicyInfra();
    await expect(policy.healthCheck()).resolves.toMatchObject({ status: 'unhealthy' });
    await expect(policy.check(request)).rejects.toThrow('Not initialized');
    await expect(policy.batchCheck({ checks: [request] })).rejects.toThrow('Not initialized');
  });

  it('checks a direct relationship before inherited roles and caches the decision', async () => {
    const db = storage({ direct: true });
    const cache = memoryCache();
    const policy = new BuiltinPolicyInfra();
    await policy.initialize({ REBAC_CACHE: cache } as InfraEnv, db);

    await expect(policy.check(request)).resolves.toEqual({
      allowed: true,
      resolution_method: 'direct',
      cached: false,
    });
    expect(db.adapter.queryOne).toHaveBeenCalledTimes(1);
    expect(db.adapter.queryOne).toHaveBeenCalledWith(expect.stringContaining('SELECT COUNT(*)'), [
      'user',
      'alice',
      'viewer',
      'document',
      'report',
      expect.any(Number),
    ]);
    expect(cache.put).toHaveBeenCalledWith(cacheKey, 'true', { expirationTtl: 60 });

    await expect(policy.check(request)).resolves.toEqual({
      allowed: true,
      resolution_method: 'direct',
      cached: true,
    });
    expect(db.adapter.queryOne).toHaveBeenCalledTimes(1);
  });

  it('checks role inheritance only after a direct miss', async () => {
    const db = storage({ inherited: true });
    const policy = new BuiltinPolicyInfra();
    await policy.initialize({} as InfraEnv, db);

    await expect(policy.check(request)).resolves.toEqual({
      allowed: true,
      resolution_method: 'inherited',
      cached: false,
    });
    expect(db.adapter.queryOne).toHaveBeenCalledTimes(2);
    expect(db.adapter.queryOne).toHaveBeenLastCalledWith(
      expect.stringContaining('WITH RECURSIVE role_chain'),
      ['alice', expect.any(Number), 'viewer', 'document', 'report']
    );
  });

  it('caches a denied decision and returns it without another database lookup', async () => {
    const db = storage();
    const cache = memoryCache();
    const policy = new BuiltinPolicyInfra();
    await policy.initialize({ REBAC_CACHE: cache } as InfraEnv, db);

    await expect(policy.check(request)).resolves.toEqual({ allowed: false, cached: false });
    expect(cache.put).toHaveBeenCalledWith(cacheKey, 'false', { expirationTtl: 60 });
    await expect(policy.check(request)).resolves.toEqual({
      allowed: false,
      resolution_method: 'direct',
      cached: true,
    });
    expect(db.adapter.queryOne).toHaveBeenCalledTimes(2);
  });

  it('uses the database when cache reads or writes fail', async () => {
    const db = storage({ direct: true });
    const cache = memoryCache();
    vi.mocked(cache.get).mockRejectedValue(new Error('KV unavailable'));
    vi.mocked(cache.put).mockRejectedValue(new Error('KV unavailable'));
    const policy = new BuiltinPolicyInfra();
    await policy.initialize({ REBAC_CACHE: cache } as InfraEnv, db);

    await expect(policy.check(request)).resolves.toMatchObject({ allowed: true, cached: false });
    expect(db.adapter.queryOne).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['30', 30],
    ['3601', 60],
    ['0', 60],
    ['bad', 60],
  ])('uses safe cache TTL for configured value %s', async (configured, expected) => {
    const cache = memoryCache();
    const policy = new BuiltinPolicyInfra();
    await policy.initialize(
      { REBAC_CACHE: cache, REBAC_CACHE_TTL_SECONDS: configured } as InfraEnv,
      storage({ direct: true })
    );

    await policy.check(request);
    expect(cache.put).toHaveBeenCalledWith(cacheKey, 'true', { expirationTtl: expected });
  });

  it('invalidates selected cache keys without claiming unsupported bulk invalidation', async () => {
    const cache = memoryCache({ [cacheKey]: 'true', 'rebac:other': 'false' });
    const policy = new BuiltinPolicyInfra();
    await policy.initialize({ REBAC_CACHE: cache } as InfraEnv, storage());

    await policy.invalidateCache({ keys: ['user:alice#viewer@document:report'] });
    expect(cache.values.has(cacheKey)).toBe(false);
    expect(cache.values.get('rebac:other')).toBe('false');
    await policy.invalidateCache({ all: true });
    expect(cache.delete).toHaveBeenCalledTimes(1);
  });

  it('keeps batch check result order and isolates each subject decision', async () => {
    const db = storage();
    db.adapter.queryOne.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('SELECT COUNT(*)')) return { count: params?.[1] === 'alice' ? 1 : 0 };
      return null;
    });
    const policy = new BuiltinPolicyInfra();
    await policy.initialize({} as InfraEnv, db);

    await expect(
      policy.batchCheck({
        checks: [request, { ...request, subject: 'user:bob' }],
      })
    ).resolves.toEqual({
      results: [
        { allowed: true, resolution_method: 'direct', cached: false },
        { allowed: false, cached: false },
      ],
    });
  });

  it('rejects malformed references before querying storage', async () => {
    const db = storage();
    const policy = new BuiltinPolicyInfra();
    await policy.initialize({} as InfraEnv, db);

    await expect(policy.check({ ...request, subject: 'alice' })).rejects.toThrow(
      'Invalid reference format'
    );
    await expect(policy.check({ ...request, object: 'document:report:extra' })).rejects.toThrow(
      'Invalid reference format'
    );
    expect(db.adapter.queryOne).not.toHaveBeenCalled();
  });

  it('paginates object and user lists with stable query parameters', async () => {
    const db = storage();
    db.adapter.query.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT DISTINCT to_type')) {
        return [
          { to_type: 'document', to_id: 'a' },
          { to_type: 'document', to_id: 'b' },
          { to_type: 'document', to_id: 'c' },
        ];
      }
      return [
        { from_type: 'user', from_id: 'alice' },
        { from_type: 'user', from_id: 'bob' },
        { from_type: 'user', from_id: 'carol' },
      ];
    });
    const policy = new BuiltinPolicyInfra();
    await policy.initialize({} as InfraEnv, db);

    await expect(
      policy.listObjects({
        subject: 'user:alice',
        relation: 'viewer',
        objectType: 'document',
        limit: 2,
      })
    ).resolves.toEqual({ objects: ['document:a', 'document:b'], cursor: '2' });
    expect(db.adapter.query).toHaveBeenCalledWith(
      expect.stringContaining('SELECT DISTINCT to_type'),
      ['user', 'alice', 'viewer', 'document', 3, 0]
    );
    await expect(
      policy.listUsers({ object: 'document:a', relation: 'viewer', limit: 2, cursor: '4' })
    ).resolves.toEqual({ users: ['user:alice', 'user:bob'], cursor: '6' });
    expect(db.adapter.query).toHaveBeenCalledWith(
      expect.stringContaining('SELECT DISTINCT from_type'),
      ['document', 'a', 'viewer', 3, 4]
    );
  });
});
