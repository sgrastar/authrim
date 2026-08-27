import { exportJWK, generateKeyPair, importJWK, jwtVerify } from 'jose';
import { describe, expect, it, vi } from 'vitest';
import { createPhase1AdminTokenProvider } from './admin-token.js';
import { PHASE1_EXECUTION_CONFIRMATION, parsePhase1HarnessConfig } from './schemas.js';

function baseConfig() {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    profile: 'custom',
    environment: {
      environmentId: 'phase1-test',
      baseUrl: 'https://phase1.example.invalid/',
      tenantId: 'default',
      placementPolicy: 'shared_pool',
      disposable: true,
      executionConfirmation: PHASE1_EXECUTION_CONFIRMATION,
      emailDomain: 'accounts.phase1.test.invalid',
      sourceCommit: 'abcdef0',
      controlDatabaseId: 'control-db',
    },
    credentials: {
      adminMachineClientIdEnv: 'AUTHRIM_PHASE1_ADMIN_MACHINE_CLIENT_ID',
      adminMachineKidEnv: 'AUTHRIM_PHASE1_ADMIN_MACHINE_KID',
      adminMachinePrivateJwkBase64Env: 'AUTHRIM_PHASE1_ADMIN_MACHINE_PRIVATE_JWK_BASE64',
      cloudflareAccountIdEnv: 'AUTHRIM_PHASE1_CLOUDFLARE_ACCOUNT_ID',
      cloudflareD1ReadTokenEnv: 'AUTHRIM_PHASE1_D1_READ_TOKEN',
      cloudflareD1WriteTokenEnv: 'AUTHRIM_PHASE1_D1_WRITE_TOKEN',
      seedEnv: 'AUTHRIM_PHASE1_SEED',
    },
    load: {
      accountCount: 2,
      ratePerSecond: 2,
      maximumInFlight: 2,
      retryWindowSeconds: 30,
      requestTimeoutMs: 1_000,
    },
    expectedPolicy: {
      targetAccountCount: 100,
      maxReadySpares: 1,
      maxD1Resources: 100,
      dailyD1CreateBudget: 50,
      lookupTargetActiveRouteCount: 250,
      lookupForecastHorizonSeconds: 300,
      lookupEwmaAlphaBps: 2_500,
      lookupHeadroomBps: 2_000,
      lookupPolicyGeneration: 2,
      minimumLookupAdditions: 1,
      minimumLookupUsedAssignmentTransitions: 1,
      minimumRoleBoundaryCrossings: 1,
    },
    observation: {
      controlIntervalMs: 250,
      providerIntervalMs: 250,
      quiescenceTimeoutSeconds: 10,
      quiescenceStableWindows: 2,
    },
    attestations: {
      workersPaidPlan: true,
      scheduledTriggerLastSucceededAt: now,
      noManualInterventionFrom: now,
    },
  };
}

describe('Phase 1 Admin machine token provider', () => {
  it('issues and refreshes short-lived private_key_jwt tokens without a static bearer token', async () => {
    const pair = await generateKeyPair('ES256', { extractable: true });
    const privateJwk = await exportJWK(pair.privateKey);
    const publicJwk = await exportJWK(pair.publicKey);
    let nowMs = Date.parse('2026-08-27T00:00:00.000Z');
    let issued = 0;
    const fetcher = vi.fn(async (_url: unknown, init?: Parameters<typeof fetch>[1]) => {
      issued += 1;
      if (typeof init?.body !== 'string') throw new Error('fixture_body_invalid');
      const form = new URLSearchParams(init.body);
      const assertion = form.get('client_assertion');
      if (!assertion) throw new Error('fixture_assertion_missing');
      const key = await importJWK(publicJwk, 'ES256');
      const verified = await jwtVerify(assertion, key, {
        issuer: 'phase1-client',
        subject: 'phase1-client',
        audience: 'https://phase1.example.invalid/token',
        currentDate: new Date(nowMs),
      });
      expect(verified.protectedHeader).toMatchObject({ alg: 'ES256', kid: 'phase1-kid' });
      expect(form.get('scope')).toBe('admin:users:read admin:users:write');
      expect(new Headers(init.headers).get('X-Tenant-Id')).toBe('default');
      return new Response(
        JSON.stringify({ access_token: `machine-access-${issued}`, expires_in: 900 }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    });
    const config = parsePhase1HarnessConfig(baseConfig());
    const provider = createPhase1AdminTokenProvider({
      config,
      environment: {
        AUTHRIM_PHASE1_ADMIN_MACHINE_CLIENT_ID: 'phase1-client',
        AUTHRIM_PHASE1_ADMIN_MACHINE_KID: 'phase1-kid',
        AUTHRIM_PHASE1_ADMIN_MACHINE_PRIVATE_JWK_BASE64: Buffer.from(
          JSON.stringify(privateJwk)
        ).toString('base64url'),
      },
      fetcher: fetcher as typeof fetch,
      nowMs: () => nowMs,
    });

    await expect(provider.getToken()).resolves.toBe('machine-access-1');
    await expect(provider.getToken()).resolves.toBe('machine-access-1');
    nowMs += 841_000;
    await expect(provider.getToken()).resolves.toBe('machine-access-2');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects a partially configured machine credential', () => {
    const value = baseConfig();
    delete (value.credentials as Record<string, unknown>).adminMachineKidEnv;
    expect(() => parsePhase1HarnessConfig(value)).toThrow(
      'phase1_admin_auth_configuration_invalid'
    );
  });
});
