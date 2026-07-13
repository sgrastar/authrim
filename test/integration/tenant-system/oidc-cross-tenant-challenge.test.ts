import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { getChallengeStoreByChallengeId } from '@authrim/ar-lib-core';
import { loginChallengeGetHandler } from '../../../packages/ar-auth/src/login-challenge';
import { load as loginLoad } from '../../../packages/ar-login-ui/src/routes/login/+page.server';
import {
  buildEnvForTopology,
  createTenantSystemApiFetch,
  makeTenantHost,
  seedTenantDataset,
} from './helpers';

vi.mock('$env/dynamic/public', () => ({ env: {} }));

describe('multi-tenant OIDC challenge conformance', () => {
  it('OIDC-010 rejects a challenge_id that belongs to a different tenant', async () => {
    const env = await buildEnvForTopology('D3_custom_subdomain', {
      ENABLE_CONFORMANCE_MODE: 'true',
    });
    await seedTenantDataset(env, 'default');

    const challengeId = 'challenge-owned-by-second';
    const secondTenantChallengeStore = await getChallengeStoreByChallengeId(
      env,
      challengeId,
      'second'
    );
    await secondTenantChallengeStore.storeChallengeRpc({
      id: challengeId,
      tenantId: 'second',
      type: 'login',
      userId: 'anonymous',
      challenge: challengeId,
      ttl: 300,
      metadata: {
        client_id: 'client_second',
        redirect_uri: 'https://app-second.example.test/callback',
        tenant_id: 'second',
      },
    });

    const firstTenantApi = new Hono();
    firstTenantApi.use('*', async (c, next) => {
      c.set('tenantId', 'first');
      await next();
    });
    firstTenantApi.get('/auth/login-challenge', loginChallengeGetHandler);

    const firstTenantHost = makeTenantHost('D3_custom_subdomain', 'first');
    const firstTenantFetch = createTenantSystemApiFetch(firstTenantApi, env, firstTenantHost);
    const firstTenantLoginUrl = new URL(`https://${firstTenantHost}/login`);
    firstTenantLoginUrl.searchParams.set('challenge_id', challengeId);

    await expect(
      loginLoad({
        cookies: { get: () => undefined, set: () => undefined, delete: () => undefined },
        fetch: firstTenantFetch,
        request: new Request(firstTenantLoginUrl),
        url: firstTenantLoginUrl,
      } as never)
    ).rejects.toMatchObject({
      status: 303,
      location:
        '/error?error=invalid_request&error_description=Authorization%20challenge%20is%20invalid%20or%20expired',
    });
  });
});
