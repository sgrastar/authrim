import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '../../db/adapter';
import type { Env } from '../../types/env';
import {
  createRefreshTokenFamily,
  getRefreshTokenRotatorStubByJti,
  revokeUserRefreshTokenFamilies,
} from '../refresh-token-family-store';
import { getRefreshToken } from '../../utils/refresh-token-store';
import { buildRefreshTokenRotatorInstanceName } from '../../utils/refresh-token-sharding';

describe('refresh-token-family-store', () => {
  const tenantId = 'tenant_test';

  let env: Env;

  beforeEach(() => {
    env = {
      REFRESH_TOKEN_ROTATOR: {
        idFromName: vi.fn().mockImplementation((name: string) => name),
        get: vi.fn(),
      },
    } as unknown as Env;
  });

  it('creates a refresh token family on the sharded rotator instance', async () => {
    const createFamilyRpc = vi.fn().mockResolvedValue({
      version: 1,
      newJti: 'issued-jti',
      expiresIn: 3600,
      allowedScope: 'openid offline_access',
    });
    (env.REFRESH_TOKEN_ROTATOR.get as any).mockReturnValue({ createFamilyRpc });

    const result = await createRefreshTokenFamily(env, {
      userId: 'user_123',
      clientId: 'client_123',
      scope: 'openid offline_access',
      ttl: 3600,
      tenantId,
      resourceAudience: 'svc://api',
    });

    expect(result.jti).toMatch(/^v\d+_\d+_rt_/);
    expect(env.REFRESH_TOKEN_ROTATOR.idFromName).toHaveBeenCalledWith(
      buildRefreshTokenRotatorInstanceName(
        'client_123',
        result.resolution.generation,
        result.resolution.shardIndex,
        tenantId
      )
    );
    expect(createFamilyRpc).toHaveBeenCalledWith({
      jti: result.jti,
      userId: 'user_123',
      clientId: 'client_123',
      scope: 'openid offline_access',
      ttl: 3600,
      tenantId,
      resourceAudience: 'svc://api',
      generation: result.resolution.generation,
      shardIndex: result.resolution.shardIndex,
    });
  });

  it('routes duplicated user and client IDs to tenant-separated rotator instances', async () => {
    const createFamilyRpc = vi.fn().mockResolvedValue({
      version: 1,
      newJti: 'issued-jti',
      expiresIn: 3600,
      allowedScope: 'openid offline_access',
    });
    (env.REFRESH_TOKEN_ROTATOR.get as any).mockReturnValue({ createFamilyRpc });

    const tenantAResult = await createRefreshTokenFamily(env, {
      userId: 'shared-user',
      clientId: 'shared-client',
      scope: 'openid offline_access',
      ttl: 3600,
      tenantId: 'tenant-a',
    });
    const tenantBResult = await createRefreshTokenFamily(env, {
      userId: 'shared-user',
      clientId: 'shared-client',
      scope: 'openid offline_access',
      ttl: 3600,
      tenantId: 'tenant-b',
    });

    expect(tenantAResult.resolution.shardIndex).toBe(tenantBResult.resolution.shardIndex);
    expect(tenantAResult.resolution.instanceName).toBe(
      `tenant:tenant-a:refresh-rotator:shared-client:v${tenantAResult.resolution.generation}:shard-${tenantAResult.resolution.shardIndex}`
    );
    expect(tenantBResult.resolution.instanceName).toBe(
      `tenant:tenant-b:refresh-rotator:shared-client:v${tenantBResult.resolution.generation}:shard-${tenantBResult.resolution.shardIndex}`
    );
    expect(tenantAResult.resolution.instanceName).not.toBe(tenantBResult.resolution.instanceName);
    expect(createFamilyRpc).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        userId: 'shared-user',
        clientId: 'shared-client',
        tenantId: 'tenant-a',
      })
    );
    expect(createFamilyRpc).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        userId: 'shared-user',
        clientId: 'shared-client',
        tenantId: 'tenant-b',
      })
    );
  });

  it('returns refresh family resource audience from durable metadata', async () => {
    const validateRpc = vi.fn().mockResolvedValue({
      valid: true,
      family: {
        allowed_scope: 'openid offline_access',
        expires_at: Date.now() + 3600_000,
        resource_aud: ['svc://api', 'svc://admin'],
      },
    });
    (env.REFRESH_TOKEN_ROTATOR.get as any).mockReturnValue({ validateRpc });

    const result = await getRefreshToken(
      env,
      'user_123',
      1,
      'client_123',
      'g1:wnam:7:rt_abc123',
      tenantId
    );

    expect(result?.resource_aud).toEqual(['svc://api', 'svc://admin']);
    // Only the family's latest token is valid: the presented JWT ID goes with the check.
    expect(validateRpc).toHaveBeenCalledWith('user_123', 1, 'client_123', 'g1:wnam:7:rt_abc123');
  });

  it('resolves an existing rotator stub from a sharded refresh token JTI', () => {
    const stub = { rotateRpc: vi.fn() };
    (env.REFRESH_TOKEN_ROTATOR.get as any).mockReturnValue(stub);

    const result = getRefreshTokenRotatorStubByJti(
      env,
      'client_123',
      'g1:wnam:7:rt_abc123',
      tenantId
    );

    expect(result.stub).toBe(stub);
    expect(result.resolution).toMatchObject({
      generation: 1,
      shardIndex: 7,
      jti: 'g1:wnam:7:rt_abc123',
    });
    expect(env.REFRESH_TOKEN_ROTATOR.idFromName).toHaveBeenCalledWith(
      'tenant:tenant_test:refresh-rotator:client_123:v1:shard-7'
    );
  });
});

describe('revokeUserRefreshTokenFamilies', () => {
  const tenantId = 'tenant-a';
  const now = 1_800_000_000_000;

  let db: DatabaseSync;
  let adapter: DatabaseAdapter;
  let env: Env;
  let revokeFamilyRpc: ReturnType<typeof vi.fn>;

  const seed = (jti: string, clientId: string, userId = 'user-1', expiresAt = now + 60_000) =>
    db
      .prepare(
        `INSERT INTO user_token_families (jti, tenant_id, user_id, client_id, generation, expires_at)
         VALUES (?, ?, ?, ?, 1, ?)`
      )
      .run(jti, tenantId, userId, clientId, expiresAt);
  const revoked = () =>
    (
      db
        .prepare('SELECT jti FROM user_token_families WHERE is_revoked = 1 ORDER BY jti')
        .all() as Array<{ jti: string }>
    ).map((row) => row.jti);

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE user_token_families (
      jti TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      client_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      is_revoked INTEGER DEFAULT 0
    )`);
    adapter = {
      async query(sql: string, params: unknown[] = []) {
        return db.prepare(sql).all(...(params as Array<string | number | null>));
      },
      async queryOne(sql: string, params: unknown[] = []) {
        return db.prepare(sql).get(...(params as Array<string | number | null>)) ?? null;
      },
      async execute(sql: string, params: unknown[] = []) {
        const result = db.prepare(sql).run(...(params as Array<string | number | null>));
        return { success: true, rowsAffected: Number(result.changes) };
      },
      transaction: vi.fn(),
      batch: vi.fn(),
      isHealthy: vi.fn(),
      getType: () => 'sqlite',
      close: vi.fn(),
    } as unknown as DatabaseAdapter;
    revokeFamilyRpc = vi.fn().mockResolvedValue(undefined);
    env = {
      REFRESH_TOKEN_ROTATOR: {
        idFromName: vi.fn((name: string) => name),
        get: vi.fn(() => ({ revokeFamilyRpc })),
      },
    } as unknown as Env;
  });

  it("revokes only the client's families, once per rotator instance, and marks them in the index", async () => {
    seed('g1:wnam:3:rt_a1', 'client-a');
    seed('g1:wnam:3:rt_a2', 'client-a');
    seed('g1:wnam:5:rt_a3', 'client-a');
    seed('g1:wnam:3:rt_b1', 'client-b');
    seed('g1:wnam:3:rt_other', 'client-a', 'user-2');

    const result = await revokeUserRefreshTokenFamilies(env, adapter, {
      tenantId,
      userId: 'user-1',
      clientId: 'client-a',
      reason: 'consent_revoked',
    });

    expect(result).toEqual({ familyCount: 3, instanceCount: 2 });
    expect(revokeFamilyRpc).toHaveBeenCalledTimes(2);
    expect(revokeFamilyRpc).toHaveBeenCalledWith('user-1', 'consent_revoked');
    expect(
      (env.REFRESH_TOKEN_ROTATOR.idFromName as ReturnType<typeof vi.fn>).mock.calls.map(
        ([name]) => name
      )
    ).not.toContain('tenant:tenant-a:refresh-rotator:client-b:v1:shard-3');
    expect(revoked()).toEqual(['g1:wnam:3:rt_a1', 'g1:wnam:3:rt_a2', 'g1:wnam:5:rt_a3']);
  });

  it('revokes every client when no client is given', async () => {
    seed('g1:wnam:3:rt_a1', 'client-a');
    seed('g1:wnam:3:rt_b1', 'client-b');

    const result = await revokeUserRefreshTokenFamilies(env, adapter, {
      tenantId,
      userId: 'user-1',
      reason: 'identifier_replaced',
    });

    expect(result).toEqual({ familyCount: 2, instanceCount: 2 });
    expect(revoked()).toEqual(['g1:wnam:3:rt_a1', 'g1:wnam:3:rt_b1']);
  });

  it('revokes a family whose indexed expiry has passed: a rotation may have moved it on unseen', async () => {
    seed('g1:wnam:3:rt_lagging', 'client-a', 'user-1', 1);

    const result = await revokeUserRefreshTokenFamilies(env, adapter, {
      tenantId,
      userId: 'user-1',
      clientId: 'client-a',
      reason: 'consent_revoked',
    });

    expect(result).toEqual({ familyCount: 1, instanceCount: 1 });
    expect(revokeFamilyRpc).toHaveBeenCalledWith('user-1', 'consent_revoked');
    expect(revoked()).toEqual(['g1:wnam:3:rt_lagging']);
  });

  it('leaves a family indexed after the listing findable for a later revocation', async () => {
    seed('g1:wnam:3:rt_a1', 'client-a');
    revokeFamilyRpc.mockImplementation(async () => {
      // Issued meanwhile in another shard: the rotators revoked did not end it.
      seed('g1:wnam:7:rt_new', 'client-a');
    });

    await revokeUserRefreshTokenFamilies(env, adapter, {
      tenantId,
      userId: 'user-1',
      clientId: 'client-a',
      reason: 'consent_revoked',
    });

    expect(revoked()).toEqual(['g1:wnam:3:rt_a1']);
  });

  it('completes without a rotator call when the user has no families', async () => {
    const result = await revokeUserRefreshTokenFamilies(env, adapter, {
      tenantId,
      userId: 'user-1',
      clientId: 'client-a',
      reason: 'consent_revoked',
    });

    expect(result).toEqual({ familyCount: 0, instanceCount: 0 });
    expect(revokeFamilyRpc).not.toHaveBeenCalled();
  });

  it('leaves the index as it was when a rotator cannot revoke', async () => {
    seed('g1:wnam:3:rt_a1', 'client-a');
    revokeFamilyRpc.mockRejectedValue(new Error('rotator unavailable'));

    await expect(
      revokeUserRefreshTokenFamilies(env, adapter, {
        tenantId,
        userId: 'user-1',
        clientId: 'client-a',
        reason: 'consent_revoked',
      })
    ).rejects.toThrow('rotator unavailable');
    expect(revoked()).toEqual([]);
  });
});
