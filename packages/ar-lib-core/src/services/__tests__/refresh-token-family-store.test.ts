import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../types/env';
import {
  createRefreshTokenFamily,
  getRefreshTokenRotatorStubByJti,
} from '../refresh-token-family-store';
import { getRefreshToken } from '../../utils/refresh-token-store';
import { buildRefreshTokenRotatorInstanceName } from '../../utils/refresh-token-sharding';

describe('refresh-token-family-store', () => {
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
      resourceAudience: 'svc://api',
    });

    expect(result.jti).toMatch(/^v\d+_\d+_rt_/);
    expect(env.REFRESH_TOKEN_ROTATOR.idFromName).toHaveBeenCalledWith(
      buildRefreshTokenRotatorInstanceName(
        'client_123',
        result.resolution.generation,
        result.resolution.shardIndex
      )
    );
    expect(createFamilyRpc).toHaveBeenCalledWith({
      jti: result.jti,
      userId: 'user_123',
      clientId: 'client_123',
      scope: 'openid offline_access',
      ttl: 3600,
      resourceAudience: 'svc://api',
      generation: result.resolution.generation,
      shardIndex: result.resolution.shardIndex,
    });
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
      'g1:wnam:7:rt_abc123'
    );

    expect(result?.resource_aud).toEqual(['svc://api', 'svc://admin']);
    expect(validateRpc).toHaveBeenCalledWith('user_123', 1, 'client_123');
  });

  it('resolves an existing rotator stub from a sharded refresh token JTI', () => {
    const stub = { rotateRpc: vi.fn() };
    (env.REFRESH_TOKEN_ROTATOR.get as any).mockReturnValue(stub);

    const result = getRefreshTokenRotatorStubByJti(env, 'client_123', 'g1:wnam:7:rt_abc123');

    expect(result.stub).toBe(stub);
    expect(result.resolution).toMatchObject({
      generation: 1,
      shardIndex: 7,
      jti: 'g1:wnam:7:rt_abc123',
    });
    expect(env.REFRESH_TOKEN_ROTATOR.idFromName).toHaveBeenCalledWith(
      'tenant:default:refresh-rotator:client_123:v1:shard-7'
    );
  });
});
