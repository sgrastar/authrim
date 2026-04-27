import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../types/env';
import {
  createRefreshTokenFamily,
  getRefreshTokenRotatorStubByJti,
} from '../refresh-token-family-store';
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
      generation: result.resolution.generation,
      shardIndex: result.resolution.shardIndex,
    });
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
