import { describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';
import {
  buildEnvForTopology,
  createTenantSystemDiscoveryApp,
  makeCommonHost,
  makeTenantHost,
  makeTenantRequest,
  seedTenantDataset,
} from './helpers';
import { loadMatrixCsv } from './fixtures/matrix-loader';

interface CookieSessionMatrixRow {
  case_id: string;
  cookie_session_item: string;
  condition: string;
  expect: string;
  test_type: string;
}

describe('tenant-system discovery grant matrix', () => {
  const rows = loadMatrixCsv<CookieSessionMatrixRow>(
    'tenant-system-cookie-session-matrix.csv'
  ).filter((row) => row.cookie_session_item.includes('discovery grant'));

  it.each(rows)('$case_id has grant coverage metadata', (row) => {
    expect(row.condition).toBeTruthy();
    expect(row.expect).toBeTruthy();
    expect(row.test_type).toBeTruthy();
  });

  it('CS-008 rejects expired discovery grants', async () => {
    const env = await buildEnvForTopology('D3_custom_subdomain');
    await seedTenantDataset(env, 'default');
    const app = createTenantSystemDiscoveryApp('first');
    const tenantHost = makeTenantHost('D3_custom_subdomain', 'first');
    const currentUrl = `https://${tenantHost}/login`;
    const key = new TextEncoder().encode(`authrim.discovery_grant.v1:${env.OTP_HMAC_SECRET}`);
    const grant = await new SignJWT({
      tenant_id: 'first',
      target_url: currentUrl,
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer('authrim:discovery-grant')
      .setAudience('authrim:tenant-login')
      .setSubject('first')
      .setIssuedAt(Math.floor(Date.now() / 1000) - 600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 300)
      .sign(key);

    const response = await app.request(
      makeTenantRequest(tenantHost, '/api/auth/discovery/grant/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ grant, current_url: currentUrl }),
      }),
      {},
      env
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: 'invalid_grant' });
  });

  it('CS-009 rejects tampered discovery grants', async () => {
    const env = await buildEnvForTopology('D3_custom_subdomain');
    await seedTenantDataset(env, 'default');
    const app = createTenantSystemDiscoveryApp('first');
    const commonHost = makeCommonHost('D3_custom_subdomain');
    const tenantHost = makeTenantHost('D3_custom_subdomain', 'first');
    const currentUrl = `https://${tenantHost}/login`;

    const issueResponse = await app.request(
      makeTenantRequest(commonHost, '/api/auth/discovery/grant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tenant_id: 'first',
          expected_tenant_id: 'first',
          return_to: currentUrl,
        }),
      }),
      {},
      env
    );
    const issued = (await issueResponse.json()) as { grant: string };
    const [header, payload, signature] = issued.grant.split('.');
    const tamperIndex = Math.floor(payload.length / 2);
    const replacement = payload[tamperIndex] === 'A' ? 'B' : 'A';
    const tamperedPayload = `${payload.slice(0, tamperIndex)}${replacement}${payload.slice(
      tamperIndex + 1
    )}`;
    const tamperedGrant = `${header}.${tamperedPayload}.${signature}`;

    expect(tamperedPayload).not.toBe(payload);

    const response = await app.request(
      makeTenantRequest(tenantHost, '/api/auth/discovery/grant/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ grant: tamperedGrant, current_url: currentUrl }),
      }),
      {},
      env
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: 'invalid_grant' });
  });

  it.each([
    ['CS-010', 'https://evil.example.test/login'],
    ['CS-011', `https://${makeTenantHost('D3_custom_subdomain', 'first')}/admin`],
  ] as const)('%s rejects unsafe discovery grant return_to values', async (_caseId, returnTo) => {
    const env = await buildEnvForTopology('D3_custom_subdomain');
    await seedTenantDataset(env, 'default');
    const app = createTenantSystemDiscoveryApp('first');
    const tenantHost = makeTenantHost('D3_custom_subdomain', 'first');

    const response = await app.request(
      makeTenantRequest(makeCommonHost('D3_custom_subdomain'), '/api/auth/discovery/grant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tenant_id: 'first',
          expected_tenant_id: 'first',
          return_to: returnTo,
        }),
      }),
      {},
      env
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { login_url: string };
    const loginUrl = new URL(body.login_url);
    expect(loginUrl.origin).toBe(`https://${tenantHost}`);
    expect(loginUrl.pathname).toBe('/login');
  });
});
