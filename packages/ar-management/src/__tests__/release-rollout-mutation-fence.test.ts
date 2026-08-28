import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import { releaseRolloutMutationFenceMiddleware } from '../release-rollout-mutation-fence';

function app(control?: Env['CONTROL']) {
  const router = new Hono<{ Bindings: Env }>();
  router.use('/api/admin/*', releaseRolloutMutationFenceMiddleware());
  router.get('/api/admin/settings', (c) => c.json({ ok: true }));
  router.put('/api/admin/settings', (c) => c.json({ ok: true }));
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
