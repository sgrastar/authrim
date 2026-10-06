import type { DatabaseSource } from '../db';
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
  RefreshTokenAuthContext,
  RotateTokenRequestV2,
  RotateTokenResponseV2,
  TokenFamilyV2,
} from '../durable-objects/RefreshTokenRotator';
import {
  listRefreshTokenFamiliesByUser,
  markRefreshTokenFamiliesRevoked,
} from './refresh-token-family-index';

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
  revokeFamilyIfFirstJtiRpc(userId: string, firstJti: string, reason?: string): Promise<boolean>;
  getFamilyRpc(userId: string): Promise<TokenFamilyV2 | null>;
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export interface RefreshTokenRotatorResolution {
  instanceName: string;
  generation: number;
  shardIndex: number | null;
  tenantId: string;
  jti?: string;
}

export interface CreateRefreshTokenFamilyInput {
  userId: string;
  clientId: string;
  scope: string;
  ttl: number;
  tenantId: string;
  resourceAudience?: string | string[];
  /** How the user authenticated for the grant beginning the family (RefreshTokenAuthContext). */
  authContext?: RefreshTokenAuthContext;
  /** The user's consent withdrawal generation for the client the grant was given under. */
  consentGeneration?: number;
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
  jti: string,
  tenantId: string
): {
  stub: RefreshTokenRotatorRpcStub;
  resolution: RefreshTokenRotatorResolution;
} {
  const normalizedTenantId = tenantId.trim();
  if (!normalizedTenantId) {
    throw new Error('Refresh token rotator lookup requires tenantId');
  }

  const namespace = ensureRefreshTokenRotator(env);
  const parsedJti = parseRefreshTokenJti(jti);
  const instanceName = buildRefreshTokenRotatorInstanceName(
    clientId,
    parsedJti.generation,
    parsedJti.shardIndex,
    normalizedTenantId
  );
  const id = namespace.idFromName(instanceName);

  return {
    stub: namespace.get(id) as unknown as RefreshTokenRotatorRpcStub,
    resolution: {
      instanceName,
      generation: parsedJti.generation,
      shardIndex: parsedJti.shardIndex,
      tenantId: normalizedTenantId,
      jti,
    },
  };
}

export async function createRefreshTokenFamily(
  env: Env,
  input: CreateRefreshTokenFamilyInput
): Promise<CreateRefreshTokenFamilyResult> {
  const namespace = ensureRefreshTokenRotator(env);
  const shardConfig = await getRefreshTokenShardConfig(env, input.clientId, input.tenantId);
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
    shardIndex,
    input.tenantId
  );
  const id = namespace.idFromName(instanceName);
  const stub = namespace.get(id) as unknown as RefreshTokenRotatorRpcStub;
  const family = await stub.createFamilyRpc({
    jti,
    userId: input.userId,
    clientId: input.clientId,
    scope: input.scope,
    ttl: input.ttl,
    tenantId: input.tenantId,
    ...(input.resourceAudience && { resourceAudience: input.resourceAudience }),
    ...(input.authContext && { authContext: input.authContext }),
    ...(input.consentGeneration !== undefined && { consentGeneration: input.consentGeneration }),
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
      tenantId: input.tenantId,
      jti,
    },
  };
}

/**
 * Revoke a user's refresh-token families, optionally only those of one client, then mark them
 * revoked in the family index. `db` must hold the index rows: ar-token writes them to the user's
 * account database, so pass the account adapter, not the tenant metadata one.
 *
 * Every family the index has not marked revoked is revoked, whatever its indexed expiry: a
 * rotation records a later expiry in the background, so an indexed expiry may lag the family's.
 * A rotator instance (client, generation, shard) holds at most one family per user, and it is
 * revoked by user, not by the indexed JWT ID (the family's first one, gone once it has rotated):
 * one revocation per distinct instance. Only the listed rows are marked revoked, so a family
 * issued meanwhile stays findable. A failure throws before the index is touched, so a retry can
 * complete the revocation.
 */
export async function revokeUserRefreshTokenFamilies(
  env: Env,
  db: DatabaseSource,
  input: {
    tenantId: string;
    userId: string;
    clientId?: string | null;
    reason: string;
  }
): Promise<{ familyCount: number; instanceCount: number }> {
  const families = await listRefreshTokenFamiliesByUser(db, {
    tenantId: input.tenantId,
    userId: input.userId,
    clientId: input.clientId,
    unrevokedOnly: true,
  });
  const revokedInstances = new Set<string>();
  for (const family of families) {
    const { stub, resolution } = getRefreshTokenRotatorStubByJti(
      env,
      family.client_id,
      family.jti,
      input.tenantId
    );
    if (revokedInstances.has(resolution.instanceName)) continue;
    await stub.revokeFamilyRpc(input.userId, input.reason);
    revokedInstances.add(resolution.instanceName);
  }
  await markRefreshTokenFamiliesRevoked(db, {
    tenantId: input.tenantId,
    jtis: families.map((family) => family.jti),
  });
  return { familyCount: families.length, instanceCount: revokedInstances.size };
}
