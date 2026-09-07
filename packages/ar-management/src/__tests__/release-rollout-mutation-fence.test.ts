import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { ADMIN_PERMISSIONS, type AdminAuthContext, type Env } from '@authrim/ar-lib-core';
import { releaseRolloutMutationFenceMiddleware } from '../release-rollout-mutation-fence';

function app(control?: Env['CONTROL'], adminAuth?: AdminAuthContext) {
  const router = new Hono<{ Bindings: Env }>();
  if (adminAuth) {
    router.use('/api/admin/*', async (c, next) => {
      (c as unknown as { set: (key: string, value: AdminAuthContext) => void }).set(
        'adminAuth',
        adminAuth
      );
      return next();
    });
  }
  router.use('/api/admin/*', releaseRolloutMutationFenceMiddleware());
  router.get('/api/admin/settings', (c) => c.json({ ok: true }));
  router.put('/api/admin/settings', (c) => c.json({ ok: true }));
  router.post('/api/admin/clients', async (c) => c.json({ body: await c.req.json() }));
  router.post('/api/admin/logout', (c) => c.json({ ok: true }));
  router.post(
    '/api/admin/platform/control-plane/release-rollout/:operationId/targets/:targetId/retry',
    (c) => c.json({ ok: true })
  );
  return { router, env: { CONTROL: control } as Env };
}

describe('release rollout mutation fence', () => {
  it('keeps reads and logout available during a restricted rollout', async () => {
    const getReleaseMigrationRolloutStatus = vi.fn(async () => ({
      operationId: 'release-1',
      sourceVersion: '1.0.0',
      targetVersion: '1.1.0',
      phase: 'database_rollout' as const,
      completedTargets: 2,
      totalTargets: 10,
      adminMutationMode: 'read_only' as const,
      lastErrorCode: null,
      updatedAt: 1_800_000_000,
    }));
    const { router, env } = app({ getReleaseMigrationRolloutStatus } as unknown as Env['CONTROL']);

    expect((await router.request('/api/admin/settings', {}, env)).status).toBe(200);
    expect((await router.request('/api/admin/logout', { method: 'POST' }, env)).status).toBe(200);
    expect(getReleaseMigrationRolloutStatus).not.toHaveBeenCalled();
  });

  it('rejects writes with resumable rollout context', async () => {
    const { router, env } = app({
      getReleaseMigrationRolloutStatus: vi.fn(async () => ({
        operationId: 'release-1',
        sourceVersion: '1.0.0',
        targetVersion: '1.1.0',
        phase: 'database_rollout',
        completedTargets: 2,
        totalTargets: 10,
        adminMutationMode: 'read_only',
        lastErrorCode: null,
        updatedAt: 1_800_000_000,
      })),
    } as unknown as Env['CONTROL']);

    const response = await router.request('/api/admin/settings', { method: 'PUT' }, env);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: 'ADMIN_MUTATION_PAUSED_FOR_RELEASE',
      operationId: 'release-1',
      targetVersion: '1.1.0',
      phase: 'database_rollout',
    });
  });

  it('allows writes after completion without extracting the Control RPC method', async () => {
    const getReleaseMigrationRolloutStatus = vi.fn(async () => ({
      operationId: 'release-1',
      sourceVersion: '1.0.0',
      targetVersion: '1.1.0',
      phase: 'completed' as const,
      completedTargets: 10,
      totalTargets: 10,
      blockedTargetCount: 0,
      blockedTargets: [],
      adminMutationMode: 'available' as const,
      lastErrorCode: null,
      updatedAt: 1_800_000_000,
    }));
    Object.defineProperty(getReleaseMigrationRolloutStatus, 'call', {
      value: () => {
        throw new Error('rpc_method_extraction_unsupported');
      },
    });
    const { router, env } = app({
      getReleaseMigrationRolloutStatus,
    } as unknown as Env['CONTROL']);

    const response = await router.request('/api/admin/settings', { method: 'PUT' }, env);

    expect(response.status).toBe(200);
    expect(getReleaseMigrationRolloutStatus).toHaveBeenCalledTimes(1);
  });

  it('allows only the exact release target recovery endpoint through the fence', async () => {
    const getReleaseMigrationRolloutStatus = vi.fn(async () => ({
      operationId: 'release-1',
      sourceVersion: '1.0.0',
      targetVersion: '1.1.0',
      phase: 'blocked' as const,
      completedTargets: 9,
      totalTargets: 10,
      blockedTargetCount: 1,
      blockedTargets: [],
      adminMutationMode: 'read_only' as const,
      lastErrorCode: 'migration_d1_batch_failed',
      updatedAt: 1_800_000_000,
    }));
    const { router, env } = app({ getReleaseMigrationRolloutStatus } as unknown as Env['CONTROL']);
    const recovery =
      '/api/admin/platform/control-plane/release-rollout/op_release_1/targets/target_1/retry';

    expect((await router.request(recovery, { method: 'POST' }, env)).status).toBe(200);
    expect((await router.request(`${recovery}/extra`, { method: 'POST' }, env)).status).toBe(409);
    expect(getReleaseMigrationRolloutStatus).toHaveBeenCalledTimes(1);
  });

  it('allows only the exact initial Login UI client bootstrap for the setup machine', async () => {
    const control = {
      getReleaseMigrationRolloutStatus: vi.fn(async () => ({
        operationId: 'release-1',
        sourceVersion: null,
        targetVersion: '0.4.0',
        phase: 'workers_deployed' as const,
        completedTargets: 3,
        totalTargets: 3,
        adminMutationMode: 'read_only' as const,
        lastErrorCode: null,
        updatedAt: 1_800_000_000,
      })),
    } as unknown as Env['CONTROL'];
    const setupMachine: AdminAuthContext = {
      userId: 'machine:authrim-setup',
      authMethod: 'machine_access_token',
      actorType: 'machine',
      principalType: 'setup_tool',
      clientId: 'authrim-setup',
      roles: [],
      permissions: [ADMIN_PERMISSIONS.CLIENTS_WRITE],
    };
    const { router, env } = app(control, setupMachine);
    const origin = 'https://primary.example.test';
    const payload = {
      client_name: 'Login UI',
      description: 'System-managed public OAuth client used by the built-in Authrim Login UI.',
      redirect_uris: [
        `${origin}/callback`,
        `${origin}/reauth/callback`,
        `${origin}/device/callback`,
        `${origin}/ciba/callback`,
      ],
      grant_types: ['authorization_code'],
      response_types: ['code'],
      scope: 'openid profile email',
      is_trusted: true,
      skip_consent: true,
      token_endpoint_auth_method: 'none',
      require_pkce: true,
      browser_public_client_mode: 'cookie_fallback',
      browser_refresh_token_policy: 'disabled',
      web_origin_registry: {
        origins: [
          {
            origin,
            cors: { allowed: true },
            handoff_allowed: true,
            iframe_allowed: false,
          },
        ],
      },
    };
    const request = (body: unknown, idempotencyKey = `setup-login-ui-${'a'.repeat(32)}`) =>
      router.request(
        '/api/admin/clients',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': idempotencyKey,
          },
          body: JSON.stringify(body),
        },
        env
      );

    const accepted = await request(payload);
    expect(accepted.status).toBe(200);
    await expect(accepted.json()).resolves.toEqual({ body: payload });
    expect((await request({ ...payload, client_name: 'Other client' })).status).toBe(409);
    expect(
      (
        await request({
          ...payload,
          redirect_uris: [`https://evil.example/callback`, ...payload.redirect_uris.slice(1)],
        })
      ).status
    ).toBe(409);
    expect((await request(payload, 'setup-login-ui-invalid')).status).toBe(409);

    const downstreamPayload = {
      client_name: 'Downstream Grant Introspection',
      description:
        'System-managed confidential client used by Authrim for downstream grant introspection.',
      application_type: 'service',
      token_endpoint_auth_method: 'client_secret_basic',
      redirect_uris: ['https://downstream-introspection.authrim.invalid/callback'],
      grant_types: ['authorization_code', 'refresh_token', 'client_credentials'],
      response_types: ['code'],
      scope: 'openid',
      is_trusted: true,
      skip_consent: true,
      client_credentials_allowed: true,
    };
    expect(
      (await request(downstreamPayload, `setup-downstream-client-${'A'.repeat(24)}`)).status
    ).toBe(200);
    expect(
      (
        await request(
          { ...downstreamPayload, client_name: 'Arbitrary confidential client' },
          `setup-downstream-client-${'A'.repeat(24)}`
        )
      ).status
    ).toBe(409);
  });

  it('fails closed when a configured Control status reader cannot verify state', async () => {
    const { router, env } = app({
      getReleaseMigrationRolloutStatus: vi.fn(async () => {
        throw new Error('unavailable');
      }),
    } as unknown as Env['CONTROL']);

    const response = await router.request('/api/admin/settings', { method: 'PUT' }, env);
    expect(response.status).toBe(503);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Retry-After')).toBe('5');
    await expect(response.json()).resolves.toMatchObject({
      error: 'CONTROL_PLANE_RELEASE_ROLLOUT_UNAVAILABLE',
    });
  });

  it('fails closed when the deployed Control binding does not expose rollout status', async () => {
    const { router, env } = app({} as Env['CONTROL']);

    const response = await router.request('/api/admin/settings', { method: 'PUT' }, env);
    expect(response.status).toBe(503);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Retry-After')).toBe('5');
    await expect(response.json()).resolves.toMatchObject({
      error: 'CONTROL_PLANE_RELEASE_ROLLOUT_UNAVAILABLE',
    });
  });
});
