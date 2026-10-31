import type { Env } from '../types/env';
import type { RefreshTokenData } from '../types/oidc';
import { resolveEffectiveSettings } from '../services/effective-settings';
import { createLogger } from './logger';

const log = createLogger().module('REFRESH_TOKEN_STORE');

/** 90 days, the `oauth.refresh_token_expiry` default. */
const DEFAULT_REFRESH_TOKEN_TTL_SECONDS = 7776000;

/**
 * Store refresh token metadata using RefreshTokenRotator DO.
 *
 * Canonical path for refresh token family creation in the current sharded model.
 */
export async function storeRefreshToken(
  env: Env,
  jti: string,
  data: RefreshTokenData,
  tenantId: string
): Promise<void> {
  if (!env.REFRESH_TOKEN_ROTATOR) {
    throw new Error('REFRESH_TOKEN_ROTATOR Durable Object not available');
  }

  const { parseRefreshTokenJti, buildRefreshTokenRotatorInstanceName } =
    await import('./refresh-token-sharding');
  const parsedJti = parseRefreshTokenJti(jti);
  const instanceName = buildRefreshTokenRotatorInstanceName(
    data.client_id,
    parsedJti.generation,
    parsedJti.shardIndex,
    tenantId
  );

  const id = env.REFRESH_TOKEN_ROTATOR.idFromName(instanceName);
  const stub = env.REFRESH_TOKEN_ROTATOR.get(id);

  // The refresh token lifetime for the client, as the Settings API resolves it.
  const configuredTTL = (
    await resolveEffectiveSettings(env, 'oauth', {
      tenantId,
      clientId: data.client_id,
    })
  )['oauth.refresh_token_expiry'];
  const refreshTokenTTL =
    typeof configuredTTL === 'number' && Number.isSafeInteger(configuredTTL) && configuredTTL > 0
      ? configuredTTL
      : DEFAULT_REFRESH_TOKEN_TTL_SECONDS;

  await stub.createFamilyRpc({
    jti,
    userId: data.sub,
    clientId: data.client_id,
    scope: data.scope || '',
    ttl: refreshTokenTTL,
    tenantId,
    ...(data.resource_aud && { resourceAudience: data.resource_aud }),
    ...(data.auth_context && { authContext: data.auth_context }),
    ...(parsedJti.generation > 0 &&
      parsedJti.shardIndex !== null && {
        generation: parsedJti.generation,
        shardIndex: parsedJti.shardIndex,
      }),
  });
}

/**
 * Retrieve refresh token metadata through RefreshTokenRotator DO.
 *
 * Note: current model validates by userId/version/clientId/jti, not by a flat KV key.
 */
export async function getRefreshToken(
  env: Env,
  userId: string,
  version: number,
  clientId: string,
  jti: string,
  tenantId: string
): Promise<RefreshTokenData | null> {
  if (!env.REFRESH_TOKEN_ROTATOR) {
    throw new Error('REFRESH_TOKEN_ROTATOR Durable Object not available');
  }

  const { parseRefreshTokenJti, buildRefreshTokenRotatorInstanceName } =
    await import('./refresh-token-sharding');
  const parsedJti = parseRefreshTokenJti(jti);
  const instanceName = buildRefreshTokenRotatorInstanceName(
    clientId,
    parsedJti.generation,
    parsedJti.shardIndex,
    tenantId
  );

  const id = env.REFRESH_TOKEN_ROTATOR.idFromName(instanceName);
  const stub = env.REFRESH_TOKEN_ROTATOR.get(id);

  try {
    // Only the family's latest token: one from a family made earlier for the same user and client
    // must not read the current family (its evidence and authentication).
    const result = await stub.validateRpc(userId, version, clientId, jti);

    if (!result.valid || !result.family) {
      return null;
    }

    return {
      jti,
      client_id: clientId,
      sub: userId,
      scope: result.family.allowed_scope || '',
      resource_aud: result.family.resource_aud,
      ...(result.family.auth_context && { auth_context: result.family.auth_context }),
      ...(typeof result.family.created_at === 'number' && {
        family_created_at: result.family.created_at,
      }),
      ...(typeof result.family.consent_generation === 'number' && {
        family_consent_generation: result.family.consent_generation,
      }),
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor((result.family.expires_at || Date.now()) / 1000),
      familyId: `${userId}:${clientId}`,
    };
  } catch (error) {
    log.error('Failed to get refresh token', {}, error as Error);
    return null;
  }
}

/**
 * Delete refresh token by revoking the family through RefreshTokenRotator DO.
 */
export async function deleteRefreshToken(
  env: Env,
  jti: string,
  client_id: string,
  tenantId: string
): Promise<void> {
  if (!env.REFRESH_TOKEN_ROTATOR) {
    throw new Error('REFRESH_TOKEN_ROTATOR Durable Object not available');
  }

  const { parseRefreshTokenJti, buildRefreshTokenRotatorInstanceName } =
    await import('./refresh-token-sharding');
  const parsedJti = parseRefreshTokenJti(jti);
  const instanceName = buildRefreshTokenRotatorInstanceName(
    client_id,
    parsedJti.generation,
    parsedJti.shardIndex,
    tenantId
  );

  const id = env.REFRESH_TOKEN_ROTATOR.idFromName(instanceName);
  const stub = env.REFRESH_TOKEN_ROTATOR.get(id);

  try {
    await stub.revokeByJtiRpc(jti, 'Token revocation requested');
  } catch {
    log.debug('Token revocation completed (may already be revoked)');
  }
}
