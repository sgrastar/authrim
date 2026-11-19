/**
 * A refresh token the mut-grants-refresh-* tests present: its (already verified) claims, the
 * family state the rotator holds, and the rotator itself.
 */
import { vi, type Mock } from 'vitest';
import { mocks, callToken } from './mut-grants-harness';
import type { MockEnv } from './mocks';
import { createConfidentialClient, createTestRefreshTokenJWT } from './fixtures';
import { tokenHandler } from '../../token';

export const RT_CLIENT_ID = 'confidential-client-001';
export const RT_SECRET = 'valid-secret';
export const RT_SCOPE = 'openid profile offline_access';
export const RT_JTI = 'rt-presented-jti';

export function refreshClient(overrides: Record<string, unknown> = {}) {
  return createConfidentialClient({
    token_endpoint_auth_method: 'client_secret_post',
    ...overrides,
  });
}

export interface PresentedRefreshToken {
  token: string;
  payload: Record<string, unknown>;
  rotateRpc: Mock<(input: Record<string, unknown>) => Promise<unknown>>;
}

/** Registers the client, the presented token's claims, its family and a rotator. */
export function presentRefreshToken(
  env: MockEnv,
  options: {
    client?: Record<string, unknown>;
    payload?: Record<string, unknown>;
    family?: Record<string, unknown>;
    rotation?: Record<string, unknown> | Error;
  } = {}
): PresentedRefreshToken {
  const now = Math.floor(Date.now() / 1000);
  mocks.getClientCached.mockResolvedValue(refreshClient(options.client));
  const payload = {
    iss: 'https://auth.example.com',
    sub: 'user-001',
    aud: RT_CLIENT_ID,
    client_id: RT_CLIENT_ID,
    scope: RT_SCOPE,
    jti: RT_JTI,
    iat: now,
    exp: now + 86400,
    ...options.payload,
  };
  mocks.parseToken.mockReturnValue(payload);
  mocks.getRefreshToken.mockResolvedValue({
    sub: 'user-001',
    client_id: RT_CLIENT_ID,
    scope: RT_SCOPE,
    family_release_approval: ['*'],
    ...options.family,
  });
  const rotateRpc = vi.fn<(input: Record<string, unknown>) => Promise<unknown>>();
  if (options.rotation instanceof Error) rotateRpc.mockRejectedValue(options.rotation);
  else
    rotateRpc.mockResolvedValue({
      newJti: 'rt-rotated-jti',
      newVersion: 2,
      expiresIn: 7200,
      ...options.rotation,
    });
  env.REFRESH_TOKEN_ROTATOR.get = vi.fn().mockReturnValue({ rotateRpc });
  return { token: createTestRefreshTokenJWT(), payload, rotateRpc };
}

/** Presents the refresh token with the client's secret in the body (client_secret_post). */
export function refresh(
  env: MockEnv,
  presented: PresentedRefreshToken,
  /** Parameters over the defaults; undefined leaves one out. */
  params: Record<string, string | undefined> = {},
  headers?: Record<string, string>
) {
  const body: Record<string, string | undefined> = {
    grant_type: 'refresh_token',
    refresh_token: presented.token,
    client_id: RT_CLIENT_ID,
    client_secret: RT_SECRET,
    ...params,
  };
  return callToken(
    tokenHandler,
    env,
    Object.fromEntries(
      Object.entries(body).filter((entry): entry is [string, string] => entry[1] !== undefined)
    ),
    headers
  );
}
