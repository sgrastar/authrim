import type { Env } from '../types/env';
import {
  buildRefreshTokenRotatorInstanceName,
  createRefreshTokenJti,
  generateRefreshTokenRandomPart,
  getRefreshTokenShardConfig,
  getRefreshTokenShardIndex,
  parseRefreshTokenJti,
} from '../utils/refresh-token-sharding';
import type {
  CreateFamilyRequestV3,
  RotateTokenRequestV2,
  RotateTokenResponseV2,
} from '../durable-objects/RefreshTokenRotator';

export interface RefreshTokenRotatorRpcStub {
  createFamilyRpc(request: CreateFamilyRequestV3): Promise<{
    version: number;
    newJti: string;
    expiresIn: number;
    allowedScope: string;
  }>;
  rotateRpc(request: RotateTokenRequestV2): Promise<RotateTokenResponseV2>;
  revokeByJtiRpc(jti: string, reason?: string): Promise<boolean>;
  revokeFamilyRpc(userId: string, reason?: string): Promise<void>;
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export interface RefreshTokenRotatorResolution {
  instanceName: string;
  generation: number;
  shardIndex: number | null;
  jti?: string;
}

export interface CreateRefreshTokenFamilyInput {
  userId: string;
  clientId: string;
  scope: string;
  ttl: number;
  resourceAudience?: string | string[];
}

export interface CreateRefreshTokenFamilyResult {
  jti: string;
  family: {
    version: number;
    newJti: string;
    expiresIn: number;
    allowedScope: string;
  };
  resolution: RefreshTokenRotatorResolution;
}

function ensureRefreshTokenRotator(env: Env): Env['REFRESH_TOKEN_ROTATOR'] {
  if (!env.REFRESH_TOKEN_ROTATOR) {
    throw new Error('REFRESH_TOKEN_ROTATOR Durable Object not available');
  }

  return env.REFRESH_TOKEN_ROTATOR;
}

export function getRefreshTokenRotatorStubByJti(
  env: Env,
  clientId: string,
  jti: string
): {
  stub: RefreshTokenRotatorRpcStub;
  resolution: RefreshTokenRotatorResolution;
} {
  const namespace = ensureRefreshTokenRotator(env);
  const parsedJti = parseRefreshTokenJti(jti);
  const instanceName = buildRefreshTokenRotatorInstanceName(
    clientId,
    parsedJti.generation,
    parsedJti.shardIndex
  );
  const id = namespace.idFromName(instanceName);

  return {
    stub: namespace.get(id) as unknown as RefreshTokenRotatorRpcStub,
    resolution: {
      instanceName,
      generation: parsedJti.generation,
      shardIndex: parsedJti.shardIndex,
      jti,
    },
  };
}

export async function createRefreshTokenFamily(
  env: Env,
  input: CreateRefreshTokenFamilyInput
): Promise<CreateRefreshTokenFamilyResult> {
  const namespace = ensureRefreshTokenRotator(env);
  const shardConfig = await getRefreshTokenShardConfig(env, input.clientId);
  const shardIndex = await getRefreshTokenShardIndex(
    input.userId,
    input.clientId,
    shardConfig.currentShardCount
  );
  const jti = createRefreshTokenJti(
    shardConfig.currentGeneration,
    shardIndex,
    generateRefreshTokenRandomPart()
  );
  const instanceName = buildRefreshTokenRotatorInstanceName(
    input.clientId,
    shardConfig.currentGeneration,
    shardIndex
  );
  const id = namespace.idFromName(instanceName);
  const stub = namespace.get(id) as unknown as RefreshTokenRotatorRpcStub;
  const family = await stub.createFamilyRpc({
    jti,
    userId: input.userId,
    clientId: input.clientId,
    scope: input.scope,
    ttl: input.ttl,
    ...(input.resourceAudience && { resourceAudience: input.resourceAudience }),
    generation: shardConfig.currentGeneration,
    shardIndex,
  });

  return {
    jti,
    family,
    resolution: {
      instanceName,
      generation: shardConfig.currentGeneration,
      shardIndex,
      jti,
    },
  };
}
