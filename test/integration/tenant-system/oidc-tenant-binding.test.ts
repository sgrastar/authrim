import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { authorizeHandler } from '../../../packages/ar-auth/src/authorize';
import { load as loginLoad } from '../../../packages/ar-login-ui/src/routes/login/+page.server';
import { getChallengeStoreByChallengeId } from '@authrim/ar-lib-core';
import { tenantSystemProfiles } from '../../fixtures/tenant-system/profiles';
import {
  applyLoginEntryProfile,
  buildEnvForTopology,
  createTenantSystemApiFetch,
  createTenantSystemDiscoveryApp,
  loadMatrixCsv,
  makeCommonHost,
  makeTenantHost,
  makeTenantRequest,
  seedTenantDataset,
} from './helpers';

interface OidcTenantMatrixRow {
  case_id: string;
  entry: string;
  host_client_condition: string;
  session_condition: string;
  expect: string;
}

describe('tenant-system OIDC tenant binding matrix', () => {
  const rows = loadMatrixCsv<OidcTenantMatrixRow>('tenant-system-oidc-tenant-matrix.csv');

  it.each(rows)('$case_id has OIDC binding coverage metadata', (row) => {
    expect(row.entry).toBeTruthy();
    expect(row.host_client_condition).toBeTruthy();
    expect(row.session_condition).toBeTruthy();
    expect(row.expect).toBeTruthy();
  });

  async function createAuthorizeFlow(
    tenantId: string,
    topology: 'D3_custom_subdomain' | 'D4_custom_naked' = 'D3_custom_subdomain'
  ) {
    const env = await buildEnvForTopology(topology, {
      ENABLE_CONFORMANCE_MODE: 'true',
    });
    await seedTenantDataset(env, 'default');
    await applyLoginEntryProfile(env, 'first', tenantSystemProfiles.P00);

    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('tenantId', tenantId);
      await next();
    });
    app.get('/authorize', authorizeHandler);

    return { app, env };
  }

  function authorizePath(clientId: string, redirectUri: string): string {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: 'openid',
      state: 'tenant-system-state',
    });
    return `/authorize?${params.toString()}`;
  }

  it('OIDC-001/OIDC-004 creates a login challenge for the current tenant client', async () => {
    const { app, env } = await createAuthorizeFlow('first');
    const host = makeTenantHost('D3_custom_subdomain', 'first');

    const response = await app.request(
      makeTenantRequest(
        host,
        authorizePath('client_first', 'https://app-first.example.test/callback')
      ),
      {},
      env
    );
    expect(response.status).toBe(302);
    const location = response.headers.get('location');
    expect(location).toMatch(/^\/flow\/login\?challenge_id=/);

    const challengeId = new URL(
      location!,
      'https://first.tenant-system.authrim.test'
    ).searchParams.get('challenge_id');
    expect(challengeId).toBeTruthy();
    const challengeStore = await getChallengeStoreByChallengeId(env, challengeId!);
    const challenge = await challengeStore.getChallengeRpc(challengeId!);
    expect(challenge?.metadata).toMatchObject({
      client_id: 'client_first',
      tenant_id: 'first',
      issuer: 'https://first.tenant-system.authrim.test',
    });
  });

  it('OIDC-002/OIDC-018 rejects a client that belongs to a different tenant', async () => {
    const { app, env } = await createAuthorizeFlow('first');

    const response = await app.request(
      makeTenantRequest(
        makeTenantHost('D3_custom_subdomain', 'first'),
        authorizePath('client_second', 'https://app-second.example.test/callback')
      ),
      {},
      env
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: 'invalid_client',
      error_description: 'client_id is invalid for this tenant',
    });
  });

  it('OIDC-003 rejects an unknown client before challenge creation', async () => {
    const { app, env } = await createAuthorizeFlow('first');

    const response = await app.request(
      makeTenantRequest(
        makeTenantHost('D3_custom_subdomain', 'first'),
        authorizePath('client_unknown', 'https://app-first.example.test/callback')
      ),
      {},
      env
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: 'invalid_request',
      error_description: 'client_id is invalid',
    });
  });

  it('OIDC-005/OIDC-019 rejects a redirect URI registered under another tenant client', async () => {
    const { app, env } = await createAuthorizeFlow('first');

    const response = await app.request(
      makeTenantRequest(
        makeTenantHost('D3_custom_subdomain', 'first'),
        authorizePath('client_first', 'https://app-second.example.test/callback')
      ),
      {},
      env
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toContain('redirect_uri is not registered for this client');
  });

  it('OIDC-006 uses the naked base issuer for the primary tenant in naked-domain topology', async () => {
    const { app, env } = await createAuthorizeFlow('first', 'D4_custom_naked');
    const host = makeCommonHost('D4_custom_naked');

    const response = await app.request(
      makeTenantRequest(
        host,
        authorizePath('client_first', 'https://app-first.example.test/callback')
      ),
      {},
      env
    );
    expect(response.status).toBe(302);
    const challengeId = new URL(
      response.headers.get('location')!,
      `https://${host}`
    ).searchParams.get('challenge_id');
    const challengeStore = await getChallengeStoreByChallengeId(env, challengeId!);
    const challenge = await challengeStore.getChallengeRpc(challengeId!);
    expect(challenge?.metadata).toMatchObject({
      tenant_id: 'first',
      issuer: 'https://tenant-system.authrim.test',
    });
  });

  it('OIDC-007 keeps the tenant subdomain issuer for non-primary tenants in naked-domain topology', async () => {
    const { app, env } = await createAuthorizeFlow('second', 'D4_custom_naked');
    const host = makeTenantHost('D4_custom_naked', 'second');

    const response = await app.request(
      makeTenantRequest(
        host,
        authorizePath('client_second', 'https://app-second.example.test/callback')
      ),
      {},
      env
    );
    expect(response.status).toBe(302);
    const challengeId = new URL(
      response.headers.get('location')!,
      `https://${host}`
    ).searchParams.get('challenge_id');
    const challengeStore = await getChallengeStoreByChallengeId(env, challengeId!);
    const challenge = await challengeStore.getChallengeRpc(challengeId!);
    expect(challenge?.metadata).toMatchObject({
      tenant_id: 'second',
      issuer: 'https://second.tenant-system.authrim.test',
    });
  });

  it('OIDC-009 challenge login bypasses common discovery enforcement', async () => {
    const { app, env } = await createAuthorizeFlow('first');
    const host = makeTenantHost('D3_custom_subdomain', 'first');
    const apiFetch = createTenantSystemApiFetch(createTenantSystemDiscoveryApp('first'), env);

    const response = await app.request(
      makeTenantRequest(
        host,
        authorizePath('client_first', 'https://app-first.example.test/callback')
      ),
      {},
      env
    );
    const challengeId = new URL(
      response.headers.get('location')!,
      `https://${host}`
    ).searchParams.get('challenge_id');

    await expect(
      loginLoad({
        cookies: { get: () => undefined, set: () => undefined, delete: () => undefined },
        fetch: apiFetch,
        request: new Request(`https://${host}/login?challenge_id=${challengeId}`),
        url: new URL(`https://${host}/login?challenge_id=${challengeId}`),
      } as never)
    ).resolves.toEqual({});
  });

  it.todo('OIDC-010 should reject a challenge_id that belongs to a different tenant');
});
